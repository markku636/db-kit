# 遠端桌面整合測試用的 VNC 伺服器（rd::it_tests）：TigerVNC 的 Xvnc，兩個 display——
#   5901：VNC 密碼（dbkit123）  5902：不需認證
#   docker build -t dbkit-vnc-it src-tauri/tests/docker/vnc
#   docker run -d --name dbkit-vnc -p 5901:5901 -p 5902:5902 dbkit-vnc-it
FROM debian:stable-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tigervnc-standalone-server tigervnc-tools \
 && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /root/.vnc && echo dbkit123 | vncpasswd -f > /root/.vnc/passwd && chmod 600 /root/.vnc/passwd
EXPOSE 5901 5902
CMD ["sh", "-c", "Xvnc :1 -geometry 800x600 -depth 24 -SecurityTypes VncAuth -PasswordFile /root/.vnc/passwd -rfbport 5901 & Xvnc :2 -geometry 640x480 -depth 24 -SecurityTypes None -rfbport 5902 & wait"]
