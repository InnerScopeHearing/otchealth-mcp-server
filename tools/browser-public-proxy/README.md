# Private public-web forward proxy

This small Go service provides HTTP forward proxying, HTTPS `CONNECT`, and
WebSocket upgrades to browser workers in a private VPC. It has no domain
allowlist and imposes no destination-port allowlist. The listener must remain
private: security groups are the access control boundary. The default address
is `10.0.0.10:3128`; set `PROXY_LISTEN_ADDR` to the private interface address
when deploying. `/health` is a local, metadata-free readiness response.

Every destination is resolved before forwarding. Every A and AAAA result is
checked, and a single non-public result rejects the request. Each upstream
connection repeats that check and dials one of the validated numeric IPs
directly, avoiding a second hostname lookup and DNS rebinding between checking
and connecting. IPv4 mapped IPv6 addresses are classified as IPv4. Invalid
authorities, URL userinfo, IPv6 zone IDs, malformed ports, DNS errors, and
empty DNS answers fail closed.

The service streams request and response bodies; it does not buffer complete
downloads or set a small body-size limit. HTTP hop-by-hop headers are handled
by Go's reverse proxy, and WebSocket upgrade requests pass through that path.
HTTPS `CONNECT` is a byte tunnel, so TLS remains end to end. The proxy does not
intercept TLS or inspect passwords, URLs, headers, or page bodies. It emits no
per-request logs. Startup/fatal logs contain no request or destination data.

Example browser configuration:

```sh
export HTTP_PROXY=http://10.0.0.10:3128
export HTTPS_PROXY=http://10.0.0.10:3128
```

Do not expose port 3128 to the internet. Keep proxy instances and browser
workers in the intended private network and authorize only those workers in
the proxy security group. VPC egress rules must independently block direct
access to private services and cloud metadata from browser workers. In
particular, WebRTC may use direct UDP paths and is not proven to traverse this
TCP proxy; prevent that at the worker/VPC network boundary if required.

Build and run tests with Go 1.24 or later:

```sh
go test ./...
go build -trimpath -o browser-public-proxy .
```
