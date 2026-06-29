FROM docker:cli
RUN apk add --no-cache bash curl coreutils
COPY omnisight-agent.sh /usr/local/bin/omnisight-agent
RUN chmod 755 /usr/local/bin/omnisight-agent
ENTRYPOINT ["/usr/local/bin/omnisight-agent"]
