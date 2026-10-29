import { useCallback, useEffect, useRef, useState } from "react";
import { createTerminalReaderMonitor } from "./terminal-reader.js";

export function useTerminalReader(enabled, request) {
  const [reader, setReader] = useState(null);
  const [error, setError] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const monitorRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      setReader(null);
      setError("");
      setIsChecking(false);
      return undefined;
    }
    const monitor = createTerminalReaderMonitor({
      request,
      onReader: setReader,
      onError: setError,
      onChecking: setIsChecking,
    });
    monitorRef.current = monitor;
    monitor.refresh();
    return () => {
      monitorRef.current = null;
      monitor.stop();
    };
  }, [enabled, request]);

  const refresh = useCallback(() => monitorRef.current?.refresh() ?? Promise.resolve(null), []);
  return { reader, setReader, error, isChecking, refresh };
}
