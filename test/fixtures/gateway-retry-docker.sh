#!/bin/sh
# Isolated acceptance has no Docker socket; fake host-kernel slots have no containers.
# Never permit this test boundary to start, stop or inspect any real host container.
if [ "${VM2API_CORRELATION_FIXTURE:-}" != "1" ]; then
  exit 126
fi
if [ "$1" = "inspect" ]; then
  echo 'Error: No such object: correlation-fixture-slot' >&2
  exit 1
fi
echo 'Docker operation unavailable in isolated correlation fixture' >&2
exit 1
