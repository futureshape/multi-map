#!/usr/bin/env python3
"""
Simple CORS proxy server for the Multi-Map Aircraft Tracking application.
This proxy fetches data from the ADS-B API and adds CORS headers to allow browser access.
"""

from http.server import HTTPServer, SimpleHTTPRequestHandler
import urllib.request
import json

# Configuration
ADSB_API_URL = "http://192.168.1.119/tar1090/data/aircraft.json"
PROXY_PORT = 8000

class CORSProxyHandler(SimpleHTTPRequestHandler):
    """HTTP request handler with CORS support and proxy functionality."""
    
    def end_headers(self):
        """Add CORS headers to all responses."""
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle preflight OPTIONS requests."""
        self.send_response(200)
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests - proxy API calls or serve static files."""
        if self.path == '/api/aircraft':
            # Proxy the ADS-B API request
            try:
                with urllib.request.urlopen(ADSB_API_URL, timeout=5) as response:
                    data = response.read()
                    
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(data)
                
            except Exception as e:
                # Return error as JSON
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                error_response = json.dumps({
                    'error': str(e),
                    'message': 'Failed to fetch aircraft data'
                }).encode('utf-8')
                self.wfile.write(error_response)
        else:
            # Serve static files (HTML, CSS, JS)
            super().do_GET()

def run_server():
    """Start the proxy server."""
    server_address = ('', PROXY_PORT)
    httpd = HTTPServer(server_address, CORSProxyHandler)
    
    print(f"🚀 Multi-Map Proxy Server starting...")
    print(f"📡 Proxying ADS-B data from: {ADSB_API_URL}")
    print(f"🌐 Server running at: http://localhost:{PROXY_PORT}")
    print(f"🔗 API endpoint: http://localhost:{PROXY_PORT}/api/aircraft")
    print(f"\n✨ Open http://localhost:{PROXY_PORT} in your browser")
    print(f"Press Ctrl+C to stop the server\n")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\n👋 Server stopped")
        httpd.shutdown()

if __name__ == '__main__':
    run_server()
