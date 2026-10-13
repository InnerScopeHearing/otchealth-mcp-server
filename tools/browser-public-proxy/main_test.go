package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type fakeResolver struct {
	answers []net.IPAddr
	err     error
	calls   int
}

func (f *fakeResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	f.calls++
	return f.answers, f.err
}

type changingResolver struct{ calls int }

func (f *changingResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	f.calls++
	ip := "1.1.1.1"
	if f.calls > 1 {
		ip = "127.0.0.1"
	}
	return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
}

func TestPublicIPRejectsNonPublicAndMapped(t *testing.T) {
	for _, s := range []string{"10.1.2.3", "127.0.0.1", "169.254.169.254", "100.64.1.2", "192.0.2.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "::ffff:127.0.0.1"} {
		if publicIP(net.ParseIP(s)) {
			t.Errorf("accepted %s", s)
		}
	}
	for _, s := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if !publicIP(net.ParseIP(s)) {
			t.Errorf("rejected public %s", s)
		}
	}
}
func TestAuthority(t *testing.T) {
	for _, s := range []string{"user@host:443", "[fe80::1%25eth0]:443", "host:0", "host:65536", "host:", "host/path"} {
		if _, _, e := authority(s, "443"); e == nil {
			t.Errorf("accepted authority %q", s)
		}
	}
	if h, p, e := authority("[2606:4700::1]:8443", "443"); e != nil || h != "2606:4700::1" || p != "8443" {
		t.Fatalf("parsed %q %q %v", h, p, e)
	}
}
func TestResolvePinsRejectsMixedMappedAndDNSFailureBeforeDial(t *testing.T) {
	for _, answers := range [][]net.IPAddr{{{IP: net.ParseIP("1.1.1.1")}, {IP: net.ParseIP("10.0.0.1")}}, {{IP: net.ParseIP("::ffff:169.254.169.254")}}} {
		r := &fakeResolver{answers: answers}
		dials := 0
		p := NewProxy(r, func(context.Context, string, string) (net.Conn, error) {
			dials++
			return nil, errors.New("unexpected dial")
		})
		if _, e := p.resolvePins(context.Background(), "arbitrary.example", "443"); e == nil {
			t.Fatal("accepted unsafe resolution")
		}
		if dials != 0 {
			t.Fatal("dialed blocked destination")
		}
	}
	r := &fakeResolver{err: errors.New("DNS down")}
	if _, e := NewProxy(r, nil).resolvePins(context.Background(), "a.example", "443"); e == nil {
		t.Fatal("DNS failure was not closed")
	}
}
func TestHTTPRejectsPrivateAnswersBeforeDial(t *testing.T) {
	for _, answers := range [][]net.IPAddr{{{IP: net.ParseIP("10.0.0.1")}}, {{IP: net.ParseIP("1.1.1.1")}, {IP: net.ParseIP("169.254.169.254")}}, {{IP: net.ParseIP("::ffff:127.0.0.1")}}} {
		dials := 0
		p := NewProxy(&fakeResolver{answers: answers}, func(context.Context, string, string) (net.Conn, error) {
			dials++
			return nil, errors.New("unexpected socket")
		})
		r := httptest.NewRequest(http.MethodGet, "http://arbitrary.example:8765/path", nil)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden || dials != 0 {
			t.Fatalf("status=%d dials=%d", w.Code, dials)
		}
	}
}
func TestDialUsesValidatedNumericPin(t *testing.T) {
	r := &fakeResolver{answers: []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}}
	var got string
	p := NewProxy(r, func(_ context.Context, network, address string) (net.Conn, error) {
		got = address
		return nil, errors.New("stop")
	})
	_, _ = p.dialPinned(context.Background(), "tcp", "example.test:8443")
	if got != "1.1.1.1:8443" {
		t.Fatalf("dial target %q", got)
	}
}
func TestDNSChangeBetweenCheckAndDialIsDenied(t *testing.T) {
	r := &changingResolver{}
	dials := 0
	p := NewProxy(r, func(context.Context, string, string) (net.Conn, error) {
		dials++
		return nil, errors.New("must not dial")
	})
	if _, e := p.resolvePins(context.Background(), "example.test", "443"); e != nil {
		t.Fatal(e)
	}
	if _, e := p.dialPinned(context.Background(), "tcp", "example.test:443"); e == nil {
		t.Fatal("accepted changed DNS answer")
	}
	if dials != 0 {
		t.Fatalf("dialed %d times", dials)
	}
}
func TestHTTPForwardingAndWebSocketUpgradeRoute(t *testing.T) {
	for _, upgrade := range []bool{false, true} {
		up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/x" {
				t.Errorf("path=%q", r.URL.Path)
			}
			if upgrade {
				w.Header().Set("Connection", "Upgrade")
				w.Header().Set("Upgrade", "websocket")
				w.WriteHeader(http.StatusSwitchingProtocols)
				return
			}
			b, _ := io.ReadAll(r.Body)
			_, _ = w.Write(b)
		}))
		_, _, _ = net.SplitHostPort(strings.TrimPrefix(up.URL, "http://"))
		// The transport must use our exact in-process upstream; tests use its local
		// address directly through a dial override while DNS policy remains public.
		r := &fakeResolver{answers: []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}}
		p := NewProxy(r, func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, up.Listener.Addr().String())
		})
		proxyServer := httptest.NewServer(p)
		proxyURL, _ := url.Parse(proxyServer.URL)
		client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
		method := http.MethodPost
		var body io.Reader = strings.NewReader("streamed")
		if upgrade {
			method = http.MethodGet
			body = nil
		}
		req, _ := http.NewRequest(method, "http://example.test:18443/x", body)
		if upgrade {
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
		}
		resp, e := client.Do(req)
		if e != nil {
			t.Fatalf("proxy request: %v", e)
		}
		if upgrade && resp.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("upgrade code %d", resp.StatusCode)
		}
		if !upgrade {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 || string(b) != "streamed" {
				t.Fatalf("response %d %q", resp.StatusCode, b)
			}
		}
		proxyServer.Close()
		up.Close()
	}
}
func TestCONNECTUsesPublicNumericPinAndTunnelsBytes(t *testing.T) {
	r := &fakeResolver{answers: []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}}
	pin := make(chan string, 1)
	received := make(chan string, 1)
	p := NewProxy(r, func(_ context.Context, _, address string) (net.Conn, error) {
		pin <- address
		client, server := net.Pipe()
		go func() {
			b := make([]byte, len("TLS bytes"))
			_, _ = io.ReadFull(server, b)
			received <- string(b)
			_ = server.Close()
		}()
		return client, nil
	})
	s := httptest.NewServer(p)
	defer s.Close()
	c, e := net.Dial("tcp", strings.TrimPrefix(s.URL, "http://"))
	if e != nil {
		t.Fatal(e)
	}
	_, _ = io.WriteString(c, "CONNECT arbitrary.example:9443 HTTP/1.1\r\nHost: arbitrary.example:9443\r\n\r\n")
	resp, e := http.ReadResponse(bufio.NewReader(c), &http.Request{Method: http.MethodConnect})
	if e != nil {
		t.Fatal(e)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT status %d", resp.StatusCode)
	}
	if got := <-pin; got != "1.1.1.1:9443" {
		t.Fatalf("dial pin %q", got)
	}
	_, _ = io.WriteString(c, "TLS bytes")
	_ = c.Close()
	if got := <-received; got != "TLS bytes" {
		t.Fatalf("tunnel bytes %q", got)
	}
}
func TestHealthIsLocal(t *testing.T) {
	r := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	NewProxy(nil, nil).ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
}
