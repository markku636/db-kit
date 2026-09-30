# 遠端桌面整合測試用的 RDP 伺服器（rd::it_tests）：xrdp + Xorg（xorgxrdp），工作階段只跑 xterm。
# xrdp 不做 NLA（CredSSP），協商結果是 TLS——剛好測到「用戶端提供 NLA、伺服器選 TLS」這條路。
#   docker build -t dbkit-xrdp-it src-tauri/tests/docker/xrdp
#   docker run -d --name dbkit-xrdp -p 3390:3389 dbkit-xrdp-it
FROM debian:stable-slim
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xrdp xorgxrdp xterm dbus-x11 ssl-cert \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash dbkit && echo 'dbkit:dbkit123' | chpasswd \
 && echo 'exec xterm' > /home/dbkit/.xsession && chown dbkit:dbkit /home/dbkit/.xsession \
 && adduser xrdp ssl-cert
EXPOSE 3389
CMD ["sh", "-c", "xrdp-sesman && exec xrdp --nodaemon"]
