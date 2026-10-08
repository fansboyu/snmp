FROM golang:1.27.1-alpine3.24 AS build

WORKDIR /app
ENV GOPROXY=https://goproxy.cn,direct

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o /bin/collector-go .

FROM alpine:3.24.2

RUN adduser -D -H appuser
USER appuser

COPY --from=build /bin/collector-go /bin/collector-go

ENTRYPOINT ["/bin/collector-go"]
