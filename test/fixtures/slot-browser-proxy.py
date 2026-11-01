"""Offline SOCKS5/DNS/HTTP fixture. It never opens an Internet connection."""
import json
import os
import socketserver
import struct
import urllib.parse


def exact(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise EOFError
    return data


PAGE = r"""<!doctype html><meta charset=utf-8><title>Slot browser acceptance</title>
<style>body{font:20px sans-serif;background:#eef6ff;padding:40px}button,input{font:inherit;margin:12px}</style>
<h1>Isolated slot browser</h1><input aria-label="Smoke input" id="input" autofocus placeholder="Type here"><button id="click">Click test</button><pre id="status">Checking…</pre>
<script>
(async()=>{
const slot=new URL(location.href).searchParams.get('slot');
const oldCookie=document.cookie;const oldStorage=localStorage.getItem('slot');
if(slot){document.cookie='slot='+encodeURIComponent(slot)+';path=/;SameSite=Lax;Max-Age=600';localStorage.setItem('slot',slot)}
const report={slot,oldCookie,oldStorage,cookie:document.cookie,storage:localStorage.getItem('slot'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,languages:navigator.languages,screen:[screen.width,screen.height],candidates:[]};
try{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:198.51.100.99:3478'}]});pc.onicecandidate=e=>{if(e.candidate)report.candidates.push(e.candidate.candidate)};pc.createDataChannel('smoke');await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>setTimeout(r,1200));pc.close()}catch(e){report.webrtcError=e.name}
const rect=document.querySelector('#click').getBoundingClientRect();report.button={x:screenX+(outerWidth-innerWidth)/2+rect.x+rect.width/2,y:screenY+outerHeight-innerHeight+rect.y+rect.height/2};
const send=()=>fetch('/report?data='+encodeURIComponent(JSON.stringify(report)));
await send();document.querySelector('#status').textContent=JSON.stringify(report,null,2);
document.querySelector('#click').onclick=()=>{report.clicked=true;report.clicks=(report.clicks||0)+1;report.input=document.querySelector('#input').value;send();document.body.style.background='#dcfce7'};
})();
</script>""".encode()


class Proxy(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(15)
        try:
            version, count = exact(self.rfile, 2)
            if version != 5 or 0 not in exact(self.rfile, count):
                return
            self.wfile.write(b"\x05\x00")
            version, command, _, kind = exact(self.rfile, 4)
            if version != 5 or command != 1:
                return
            if kind == 1:
                target = ".".join(map(str, exact(self.rfile, 4)))
            elif kind == 3:
                target = exact(self.rfile, exact(self.rfile, 1)[0]).decode()
            elif kind == 4:
                target = exact(self.rfile, 16).hex()
            else:
                return
            port = struct.unpack("!H", exact(self.rfile, 2))[0]
            if port not in (53, 80):
                self.wfile.write(b"\x05\x05\x00\x01" + b"\x00" * 6)
                return
            self.wfile.write(b"\x05\x00\x00\x01" + b"\x00" * 6)
            if port == 53:
                self.dns()
            else:
                self.http(target)
        except (EOFError, OSError, ValueError):
            return

    def dns(self):
        size = struct.unpack("!H", exact(self.rfile, 2))[0]
        query = exact(self.rfile, size)
        index = 12
        labels = []
        while query[index]:
            count = query[index]
            index += 1
            labels.append(query[index:index + count].decode())
            index += count
        index += 1
        kind = struct.unpack("!H", query[index:index + 2])[0]
        question = query[12:index + 4]
        answer = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x01\x00\x04\xc6\x33\x64\x63" if kind == 1 else b""
        reply = query[:2] + b"\x81\x80\x00\x01" + (b"\x00\x01" if answer else b"\x00\x00") + b"\x00\x00\x00\x00" + question + answer
        self.wfile.write(struct.pack("!H", len(reply)) + reply)
        print(json.dumps({"dns": ".".join(labels), "type": kind}), flush=True)

    def http(self, target):
        request = self.rfile.readline(16384).decode(errors="replace").split()
        if len(request) < 2:
            return
        headers = {}
        while line := self.rfile.readline(16384):
            if line in (b"\r\n", b"\n"):
                break
            name, _, value = line.decode(errors="replace").partition(":")
            headers[name.lower()] = value.strip()
        path = urllib.parse.urlsplit(request[1])
        if path.path == "/report":
            raw = urllib.parse.parse_qs(path.query).get("data", ["{}"])[0]
            print(json.dumps({"report": json.loads(raw), "accept_language": headers.get("accept-language")}), flush=True)
            body = b"ok"
        elif headers.get("host") == "browser.test":
            body = PAGE
        else:
            body = b"Offline acceptance proxy: no Internet forwarding."
        self.wfile.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server((os.environ["BROWSER_TEST_PROXY_IP"], 1080), Proxy) as server:
        print("offline proxy ready", flush=True)
        server.serve_forever()
