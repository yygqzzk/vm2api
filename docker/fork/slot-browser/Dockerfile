FROM debian:bookworm-slim AS browser
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
COPY install_chromix.py /tmp/install_chromix.py
COPY archives/ /tmp/archives/
RUN python3 /tmp/install_chromix.py "$TARGETARCH" /tmp/archives /opt

FROM debian:bookworm-slim
LABEL io.vm2api.browser.fingerprint="chromix-2" \
      io.vm2api.browser.engine="Chromix/156.0.8078.79"
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends tigervnc-standalone-server openbox wmctrl \
      python3 iptables util-linux locales-all tzdata ca-certificates fonts-liberation fonts-noto-cjk \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 \
      libdrm2 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
      libudev1 libvulkan1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon0 libxrandr2 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 browser \
 && useradd -u 1000 -g 1000 -d /profile -s /usr/sbin/nologin browser \
 && mkdir -p /profile /etc/chromium/policies/managed \
 && chown browser:browser /profile
COPY --from=browser /opt/chromix /opt/chromix
RUN ln -s /opt/chromix/chrome /usr/bin/chromium
COPY policies.json /etc/chromium/policies/managed/slot-browser.json
COPY entrypoint.py desktop.py client.py /opt/slot-browser/
ENV HOME=/profile DISPLAY=:99 LANG=en_US.UTF-8 TZ=UTC
ENTRYPOINT ["python3", "/opt/slot-browser/entrypoint.py"]
