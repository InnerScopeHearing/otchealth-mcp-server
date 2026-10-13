// Command browser-public-proxy is a private-network HTTP/HTTPS forward proxy.
// It deliberately has no credentials or request logging; network access is
// controlled by the caller's private network security group.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Resolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}
type systemResolver struct{}

func (systemResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

type dialFunc func(context.Context, string, string) (net.Conn, error)

type Proxy struct {
	resolver  Resolver
	dial      dialFunc
	transport *http.Transport
}

func NewProxy(r Resolver, d dialFunc) *Proxy {
	if r == nil {
		r = systemResolver{}
	}
	if d == nil {
		d = (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	p := &Proxy{resolver: r, dial: d}
	p.transport = &http.Transport{Proxy: nil, DialContext: p.dialPinned, ForceAttemptHTTP2: false, ResponseHeaderTimeout: 60 * time.Second, IdleConnTimeout: 90 * time.Second}
	return p
}

var deniedNets = parseNets([]string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32", "2001::/23", "2002::/16", "3fff::/20",
})
var v6Global = mustNet("2000::/3")

func parseNets(s []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(s))
	for _, x := range s {
		out = append(out, mustNet(x))
	}
	return out
}
func mustNet(s string) *net.IPNet {
	_, n, e := net.ParseCIDR(s)
	if e != nil {
		panic(e)
	}
	return n
}

func publicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		for _, n := range deniedNets {
			if n.IP.To4() != nil && n.Contains(v4) {
				return false
			}
		}
		return true
	}
	v6 := ip.To16()
	if v6 == nil || !v6Global.Contains(v6) {
		return false
	}
	for _, n := range deniedNets {
		if n.IP.To4() == nil && n.Contains(v6) {
			return false
		}
	}
	return true
}

func authority(raw string, defaultPort string) (string, string, error) {
	if raw == "" || strings.ContainsAny(raw, "\r\n\x00") {
		return "", "", errors.New("empty or invalid authority")
	}
	u, e := url.Parse("//" + raw)
	if e != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("invalid authority")
	}
	host := u.Hostname()
	if host == "" || strings.Contains(host, "%") {
		return "", "", errors.New("missing host or IPv6 zone")
	}
	port := u.Port()
	// url.URL.Port does not report a parse error; validate the original host
	// spelling so malformed and empty explicit ports cannot become defaults.
	if strings.HasSuffix(u.Host, ":") || strings.HasSuffix(u.Host, "]:") {
		return "", "", errors.New("empty port")
	}
	if port == "" {
		port = defaultPort
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 {
		return "", "", errors.New("invalid port")
	}
	return strings.TrimSuffix(strings.ToLower(host), "."), strconv.Itoa(n), nil
}

// resolvePins validates every answer and returns numeric socket addresses. No
// transport connection performs its own hostname lookup after this check.
func (p *Proxy) resolvePins(ctx context.Context, host, port string) ([]string, error) {
	ip := net.ParseIP(host)
	var ips []net.IPAddr
	if ip != nil {
		ips = []net.IPAddr{{IP: ip}}
	} else {
		var err error
		ips, err = p.resolver.LookupIPAddr(ctx, host)
		if err != nil || len(ips) == 0 {
			return nil, fmt.Errorf("DNS resolution failed")
		}
	}
	addresses := make([]string, 0, len(ips))
	for _, a := range ips {
		if !publicIP(a.IP) {
			return nil, fmt.Errorf("destination denied")
		}
		addresses = append(addresses, net.JoinHostPort(a.IP.String(), port))
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("DNS resolution failed")
	}
	return addresses, nil
}

func (p *Proxy) dialPinned(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return nil, e
	}
	addresses, e := p.resolvePins(ctx, strings.Trim(host, "[]"), port)
	if e != nil {
		return nil, e
	}
	var last error
	for _, a := range addresses {
		c, err := p.dial(ctx, network, a)
		if err == nil {
			return c, nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("no public addresses")
	}
	return nil, last
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" && r.Method == http.MethodGet && r.URL.Host == "" {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
		return
	}
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if r.URL == nil || r.URL.Host == "" || r.URL.User != nil || (r.URL.Scheme != "http" && r.URL.Scheme != "https") {
		http.Error(w, "absolute http(s) URL required", http.StatusBadRequest)
		return
	}
	defaultPort := "80"
	if r.URL.Scheme == "https" {
		defaultPort = "443"
	}
	host, port, e := authority(r.URL.Host, defaultPort)
	if e != nil {
		http.Error(w, "invalid destination", http.StatusBadRequest)
		return
	}
	if _, e = p.resolvePins(r.Context(), host, port); e != nil {
		http.Error(w, "destination denied", http.StatusForbidden)
		return
	}
	// ReverseProxy's transport performs a fresh validation and dials a numeric
	// answer per connection, closing the DNS-rebinding gap between check and use.
	target := url.URL{Scheme: r.URL.Scheme, Host: r.URL.Host}
	proxy := httputil.NewSingleHostReverseProxy(&target)
	proxy.Transport = p.transport
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}
	r.Header.Del("Proxy-Authorization")
	r.Header.Del("Proxy-Connection")
	proxy.ServeHTTP(w, r)
}

func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	host, port, e := authority(r.Host, "443")
	if e != nil {
		http.Error(w, "invalid destination", http.StatusBadRequest)
		return
	}
	addresses, e := p.resolvePins(r.Context(), host, port)
	if e != nil {
		http.Error(w, "destination denied", http.StatusForbidden)
		return
	}
	var upstream net.Conn
	for _, a := range addresses {
		upstream, e = p.dial(r.Context(), "tcp", a)
		if e == nil {
			break
		}
	}
	if e != nil || upstream == nil {
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		upstream.Close()
		http.Error(w, "CONNECT unsupported", http.StatusInternalServerError)
		return
	}
	client, rw, e := hj.Hijack()
	if e != nil {
		upstream.Close()
		return
	}
	if _, e = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); e == nil {
		e = rw.Flush()
	}
	if e != nil {
		client.Close()
		upstream.Close()
		return
	}
	if rw.Reader.Buffered() > 0 {
		_, _ = io.Copy(upstream, rw.Reader)
	}
	go func() {
		_, _ = io.Copy(upstream, client)
		if c, ok := upstream.(*net.TCPConn); ok {
			_ = c.CloseWrite()
		}
	}()
	_, _ = io.Copy(client, upstream)
	_ = client.Close()
	_ = upstream.Close()
}

func (p *Proxy) Handler() http.Handler { return p }
func main() {
	addr := os.Getenv("PROXY_LISTEN_ADDR")
	if addr == "" {
		addr = "10.0.0.10:3128"
	}
	s := &http.Server{Addr: addr, Handler: NewProxy(nil, nil), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 1 << 20}
	log.Printf("public proxy listening on %s", addr) // Contains no request or destination data.
	if e := s.ListenAndServe(); e != nil && !errors.Is(e, http.ErrServerClosed) {
		log.Fatal("proxy server failed")
	}
}
