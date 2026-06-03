import http.server, socketserver, urllib.request, urllib.parse, json

PORT = 8799
YF = "https://query1.finance.yahoo.com/v8/finance/chart/"

class H(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin","*"); self.end_headers()
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        symbol = (q.get("symbol",["MU"])[0]).upper()
        interval = q.get("interval",["1m"])[0]
        rng = q.get("range",["1d"])[0]
        pre = q.get("includePrePost",["false"])[0]
        url = YF + urllib.parse.quote(symbol) + "?interval="+interval+"&range="+rng+"&includePrePost="+pre
        try:
            req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
            body = urllib.request.urlopen(req, timeout=10).read()
            self.send_response(200)
        except Exception as e:
            body = json.dumps({"chart":{"result":None,"error":{"description":str(e)}}}).encode()
            self.send_response(502)
        self.send_header("Access-Control-Allow-Origin","*")
        self.send_header("Content-Type","application/json")
        self.end_headers()
        self.wfile.write(body)
    def log_message(self,*a): pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1",PORT),H) as httpd:
    httpd.serve_forever()
