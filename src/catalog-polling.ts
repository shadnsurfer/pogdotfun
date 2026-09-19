/** One visible-page poller: slow requests never accumulate a timer backlog. */
export function startCatalogPolling(options: {
  visible: () => boolean;
  refresh: () => Promise<void>;
  delay: () => number;
}) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const wake = () => {
    clear();
    if (stopped || running || !options.visible()) return;
    running = true;
    void (async () => {
      try {
        await options.refresh();
      } finally {
        running = false;
        if (!stopped && options.visible()) timer = setTimeout(wake, options.delay());
      }
    })().catch(() => {
      // The catalog owns its visible error state; polling must survive a rejected read.
    });
  };
  wake();
  return {
    wake,
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
