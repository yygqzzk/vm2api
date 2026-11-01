FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium tigervnc-standalone-server openbox wmctrl \
      python3 iptables util-linux locales-all tzdata ca-certificates fonts-liberation fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 browser \
 && useradd -u 1000 -g 1000 -d /profile -s /usr/sbin/nologin browser \
 && mkdir -p /profile /etc/chromium/policies/managed \
 && chown browser:browser /profile
COPY policies.json /etc/chromium/policies/managed/slot-browser.json
COPY entrypoint.py desktop.py client.py /opt/slot-browser/
ENV HOME=/profile DISPLAY=:99 LANG=en_US.UTF-8 TZ=UTC
ENTRYPOINT ["python3", "/opt/slot-browser/entrypoint.py"]
