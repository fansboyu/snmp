package syslog

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const stagingDDL = `create temporary table syslog_event_stage (
	received_at timestamptz not null,
	reported_at timestamptz,
	source_ip text not null,
	hostname text,
	facility smallint,
	severity smallint,
	app_name text,
	procid text,
	msgid text,
	structured_data text,
	syslog_version smallint,
	parsed boolean not null,
	message text not null,
	raw_message text not null
) on commit drop`

type Config struct {
	BindAddress       string
	Port              int
	HostPort          int
	MaxMessageBytes   int
	QueueSize         int
	BatchSize         int
	FlushInterval     time.Duration
	RetentionDays     int
	RetentionInterval time.Duration
}

type Event struct {
	ReceivedAt time.Time
	ReportedAt *time.Time
	SourceIP   string
	Hostname   string
	Facility   *int16
	Severity   *int16
	AppName    string
	ProcID     string
	MsgID      string
	Structured string
	Version    *int16
	Parsed     bool
	Message    string
	RawMessage string
}

type Collector struct {
	config    Config
	db        *pgxpool.Pool
	queue     chan Event
	received  atomic.Uint64
	stored    atomic.Uint64
	dropped   atomic.Uint64
	lastSeen  atomic.Int64
	lastError atomic.Value
}

func New(config Config, db *pgxpool.Pool) *Collector {
	return &Collector{config: config, db: db, queue: make(chan Event, config.QueueSize)}
}

func (c *Collector) Run(ctx context.Context) error {
	address, err := net.ResolveUDPAddr("udp", net.JoinHostPort(c.config.BindAddress, strconv.Itoa(c.config.Port)))
	if err != nil {
		return fmt.Errorf("resolve UDP address: %w", err)
	}
	conn, err := net.ListenUDP("udp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	defer conn.Close()
	if err := c.loadPreviousStatus(ctx); err != nil {
		return fmt.Errorf("load collector status: %w", err)
	}
	if err := c.writeStatus(ctx, nil); err != nil {
		return fmt.Errorf("initialize collector status: %w", err)
	}
	log.Printf("syslog collector listening on udp://%s; retention=%d days", address, c.config.RetentionDays)

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		c.readLoop(ctx, conn)
	}()

	flushTicker := time.NewTicker(c.config.FlushInterval)
	defer flushTicker.Stop()
	statusTicker := time.NewTicker(10 * time.Second)
	defer statusTicker.Stop()
	retentionTicker := time.NewTicker(c.config.RetentionInterval)
	defer retentionTicker.Stop()

	var pending []Event
	var retryAt time.Time
	flush := func(flushCtx context.Context) {
		if len(pending) == 0 || (!retryAt.IsZero() && time.Now().Before(retryAt)) {
			return
		}
		if err := c.persist(flushCtx, pending); err != nil {
			c.lastError.Store(err.Error())
			log.Printf("persist syslog batch (%d events): %v", len(pending), err)
			retryAt = time.Now().Add(2 * time.Second)
			return
		}
		c.stored.Add(uint64(len(pending)))
		pending = pending[:0]
		retryAt = time.Time{}
		c.lastError.Store("")
	}

	for {
		select {
		case event := <-c.queue:
			pending = append(pending, event)
			if len(pending) >= c.config.BatchSize {
				flush(ctx)
			}
		case <-flushTicker.C:
			flush(ctx)
		case <-statusTicker.C:
			statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := c.writeStatus(statusCtx, nil); err != nil {
				log.Printf("update collector status: %v", err)
			}
			cancel()
		case <-retentionTicker.C:
			if err := c.cleanup(ctx); err != nil {
				log.Printf("syslog retention cleanup: %v", err)
			}
		case <-ctx.Done():
			_ = conn.Close()
			select {
			case <-readerDone:
			case <-time.After(2 * time.Second):
			}
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			for {
				select {
				case event := <-c.queue:
					pending = append(pending, event)
				default:
					flush(shutdownCtx)
					if len(pending) > 0 {
						return fmt.Errorf("shutdown with %d syslog events not persisted", len(pending))
					}
					return nil
				}
			}
		}
	}
}

func (c *Collector) loadPreviousStatus(ctx context.Context) error {
	var received, stored, dropped uint64
	var lastReceived *time.Time
	err := c.db.QueryRow(ctx, `
		select received_count, stored_count, dropped_count, last_received_at
		from syslog_collector_status
		where id = 1
	`).Scan(&received, &stored, &dropped, &lastReceived)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	c.received.Store(received)
	c.stored.Store(stored)
	c.dropped.Store(dropped)
	if lastReceived != nil {
		c.lastSeen.Store(lastReceived.UnixNano())
	}
	return nil
}

func (c *Collector) readLoop(ctx context.Context, conn *net.UDPConn) {
	buffer := make([]byte, 65535)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, source, err := conn.ReadFromUDP(buffer)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			log.Printf("receive syslog packet: %v", err)
			continue
		}
		if n == 0 || source == nil || source.IP == nil {
			continue
		}
		payload := TruncateMessage(buffer[:n], c.config.MaxMessageBytes)
		event := parseEvent(payload, source.IP.String(), time.Now().UTC())
		c.received.Add(1)
		c.lastSeen.Store(event.ReceivedAt.UnixNano())
		select {
		case c.queue <- event:
		default:
			c.dropped.Add(1)
		}
	}
}

func (c *Collector) persist(ctx context.Context, events []Event) error {
	tx, err := c.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, stagingDDL); err != nil {
		return err
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"syslog_event_stage"}, []string{
		"received_at", "reported_at", "source_ip", "hostname", "facility", "severity", "app_name", "procid", "msgid", "structured_data", "syslog_version", "parsed", "message", "raw_message",
	}, pgx.CopyFromSlice(len(events), func(i int) ([]any, error) {
		event := events[i]
		return []any{event.ReceivedAt, event.ReportedAt, event.SourceIP, nullable(event.Hostname), event.Facility, event.Severity, nullable(event.AppName), nullable(event.ProcID), nullable(event.MsgID), nullable(event.Structured), event.Version, event.Parsed, event.Message, event.RawMessage}, nil
	}))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		insert into syslog_events (
			received_at, reported_at, source_ip, hostname, device_id, facility, severity,
			app_name, procid, msgid, structured_data, syslog_version, parsed, message, raw_message
		)
		select s.received_at, s.reported_at, s.source_ip::inet, s.hostname, d.id, s.facility, s.severity,
			s.app_name, s.procid, s.msgid, s.structured_data, s.syslog_version, s.parsed, s.message, s.raw_message
		from syslog_event_stage s
		left join devices d on d.host = s.source_ip
	`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (c *Collector) writeStatus(ctx context.Context, _ error) error {
	var lastSeen *time.Time
	if value := c.lastSeen.Load(); value > 0 {
		seen := time.Unix(0, value).UTC()
		lastSeen = &seen
	}
	lastError, _ := c.lastError.Load().(string)
	_, err := c.db.Exec(ctx, `
		insert into syslog_collector_status (id, started_at, updated_at, last_received_at, received_count, stored_count, dropped_count, last_error, host_port)
		values (1, now(), now(), $1, $2, $3, $4, nullif($5, ''), $6)
		on conflict (id) do update set
			started_at = excluded.started_at,
			updated_at = now(),
			last_received_at = coalesce(excluded.last_received_at, syslog_collector_status.last_received_at),
			received_count = excluded.received_count,
			stored_count = excluded.stored_count,
			dropped_count = excluded.dropped_count,
			last_error = excluded.last_error,
			host_port = excluded.host_port
	`, lastSeen, c.received.Load(), c.stored.Load(), c.dropped.Load(), lastError, c.config.HostPort)
	return err
}

func (c *Collector) cleanup(ctx context.Context) error {
	for {
		result, err := c.db.Exec(ctx, `
			delete from syslog_events
			where id in (
				select id from syslog_events
				where received_at < now() - make_interval(days => $1)
				order by received_at
				limit 5000
			)
		`, c.config.RetentionDays)
		if err != nil {
			return err
		}
		if result.RowsAffected() < 5000 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func nullable(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

var rfc3164Pattern = regexp.MustCompile(`^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(.*)$`)
var tagPattern = regexp.MustCompile(`^([^\[:]+)(?:\[([^\]]+)\])?:\s*(.*)$`)

func parseEvent(payload []byte, sourceIP string, received time.Time) Event {
	raw := strings.ToValidUTF8(string(payload), "�")
	raw = strings.ReplaceAll(raw, "\x00", "")
	event := Event{ReceivedAt: received, SourceIP: sourceIP, Message: raw, RawMessage: raw}
	rest := raw
	if strings.HasPrefix(rest, "<") {
		end := strings.IndexByte(rest, '>')
		if end > 1 && end <= 4 {
			priority, err := strconv.Atoi(rest[1:end])
			if err == nil && priority >= 0 && priority <= 191 {
				facility, severity := int16(priority/8), int16(priority%8)
				event.Facility, event.Severity = &facility, &severity
				event.Parsed = true
				rest = rest[end+1:]
			}
		}
	}
	if !event.Parsed {
		return event
	}

	if version, err := parseRFC5424(rest, &event, received); err {
		event.Version = version
		return event
	}
	parseRFC3164(rest, &event, received)
	return event
}

func parseRFC5424(rest string, event *Event, received time.Time) (*int16, bool) {
	fields := strings.SplitN(rest, " ", 8)
	if len(fields) < 7 {
		return nil, false
	}
	versionValue, err := strconv.Atoi(fields[0])
	if err != nil || versionValue < 1 || versionValue > 999 {
		return nil, false
	}
	version := int16(versionValue)
	event.Hostname = nilValue(fields[2])
	event.AppName = nilValue(fields[3])
	event.ProcID = nilValue(fields[4])
	event.MsgID = nilValue(fields[5])
	event.Structured = nilValue(fields[6])
	if len(fields) == 8 {
		event.Message = fields[7]
	} else {
		event.Message = ""
	}
	if fields[1] != "-" {
		if reported, err := time.Parse(time.RFC3339Nano, fields[1]); err == nil {
			reported = reported.UTC()
			event.ReportedAt = &reported
		} else {
			event.Parsed = false
		}
	} else {
		now := received
		event.ReportedAt = &now
	}
	return &version, true
}

func parseRFC3164(rest string, event *Event, received time.Time) {
	match := rfc3164Pattern.FindStringSubmatch(rest)
	if match == nil {
		return
	}
	event.Hostname = nilValue(match[2])
	body := match[3]
	if tag := tagPattern.FindStringSubmatch(body); tag != nil {
		event.AppName = nilValue(tag[1])
		event.ProcID = nilValue(tag[2])
		event.Message = tag[3]
	} else {
		event.Message = body
	}
	stamp := received.Format("2006 ") + match[1]
	if reported, err := time.ParseInLocation("2006 Jan _2 15:04:05", stamp, received.Location()); err == nil {
		reported = reported.UTC()
		if reported.After(received.Add(24 * time.Hour)) {
			reported = reported.AddDate(-1, 0, 0)
		}
		event.ReportedAt = &reported
	}
}

func nilValue(value string) string {
	if value == "-" {
		return ""
	}
	return strings.TrimSpace(strings.ToValidUTF8(value, "�"))
}

func TruncateMessage(payload []byte, maxBytes int) []byte {
	if len(payload) <= maxBytes {
		return payload
	}
	cut := payload[:maxBytes]
	for len(cut) > 0 && !utf8.Valid(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}
