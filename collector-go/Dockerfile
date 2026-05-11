FROM golang:1.24-alpine AS build

WORKDIR /app
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o /bin/collector-go .

FROM alpine:3.20

RUN adduser -D -H appuser
USER appuser

COPY --from=build /bin/collector-go /bin/collector-go

ENTRYPOINT ["/bin/collector-go"]
