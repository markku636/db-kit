# 遠端桌面整合測試用的 VNC 伺服器（rd::it_tests）：TigerVNC 的 Xvnc，五個 display——
#   5901：VNC 密碼（dbkit123）  5902：不需認證
#   5903：VeNCrypt 匿名 TLS（TLSVnc，密碼 dbkit123）+ VNC 密碼——TigerVNC 的預設組合，「自動」要挑 TLS
#   5904：VeNCrypt X509Vnc（自簽憑證，建映像時產生；密碼 dbkit123）
#   5905：VeNCrypt 匿名 TLS、不需認證（TLSNone）
#   docker build -t dbkit-vnc-it src-tauri/tests/docker/vnc
#   docker run -d --name dbkit-vnc -p 5901-5905:5901-5905 dbkit-vnc-it
# 失敗的連線很多（密碼錯、拒絕憑證），關掉 Xvnc 的黑名單（預設 5 次就暫時封鎖來源）。
FROM debian:stable-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools openssl \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.vnc && echo dbkit123 | vncpasswd -f > /root/.vnc/passwd && chmod 600 /root/.vnc/passwd \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=dbkit-vnc-it \
      -keyout /root/.vnc/x509-key.pem -out /root/.vnc/x509-cert.pem
EXPOSE 5901 5902 5903 5904 5905
CMD ["sh", "-c", "B='-depth 24 -BlacklistThreshold 1000000'; \
  Xvnc :1 -geometry 800x600 $B -SecurityTypes VncAuth -PasswordFile /root/.vnc/passwd -rfbport 5901 & \
  Xvnc :2 -geometry 640x480 $B -SecurityTypes None -rfbport 5902 & \
  Xvnc :3 -geometry 720x400 $B -SecurityTypes TLSVnc,VncAuth -PasswordFile /root/.vnc/passwd -rfbport 5903 & \
  Xvnc :4 -geometry 720x480 $B -SecurityTypes X509Vnc -PasswordFile /root/.vnc/passwd -X509Cert /root/.vnc/x509-cert.pem -X509Key /root/.vnc/x509-key.pem -rfbport 5904 & \
  Xvnc :5 -geometry 600x400 $B -SecurityTypes TLSNone -rfbport 5905 & \
  wait"]
