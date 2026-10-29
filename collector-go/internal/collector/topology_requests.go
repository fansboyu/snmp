package collector

import (
	"context"
	"log"
	"time"
)

type TopologyRequest struct{ ID, DeviceID int64 }
type TopologyRequestStore interface {
	ListTopologyRequests(context.Context) ([]TopologyRequest, error)
	ClaimTopologyRequest(context.Context, int64) (bool, error)
	FinishTopologyRequest(context.Context, int64, string, string) error
}

func (engine *Engine) refreshTopologyRequests(ctx context.Context, store TopologyRequestStore, queue chan<- []TopologyRequest) {
	ticker := time.NewTicker(engine.RefreshInterval)
	defer ticker.Stop()
	for {
		readCtx, cancel := context.WithTimeout(ctx, engine.DatabaseTimeout)
		requests, err := store.ListTopologyRequests(readCtx)
		cancel()
		if err != nil {
			log.Printf("read topology requests: %v", err)
		} else {
			select {
			case queue <- requests:
			case <-ctx.Done():
				return
			}
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}
