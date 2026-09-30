# 整合測試用的 RustDesk 被控端：官方 Linux 版跑在 Xvfb 上，開 Direct IP（21118）、固定密碼 dbkit123。
#   docker build -t dbkit-rustdesk-it rustdesk-bridge/tests/docker
#   docker run -d --name dbkit-rustdesk -p 21118:21118 dbkit-rustdesk-it
FROM debian:bookworm-slim
ARG RD_VERSION=1.4.9
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates wget xvfb xauth dbus-x11 x11-utils xterm procps \
 && wget -q -O /tmp/rustdesk.deb "https://github.com/rustdesk/rustdesk/releases/download/${RD_VERSION}/rustdesk-${RD_VERSION}-x86_64.deb" \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/rustdesk.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/rustdesk.deb
RUN mkdir -p /root/.config/rustdesk \
 && printf "[options]\ndirect-server = 'Y'\ndirect-access-port = '21118'\nverification-method = 'use-permanent-password'\napprove-mode = 'password'\n" > /root/.config/rustdesk/RustDesk2.toml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 21118
CMD ["/start.sh"]
