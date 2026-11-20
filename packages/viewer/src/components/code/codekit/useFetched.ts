import {useEffect, useRef, useState} from 'react';

export interface Fetched<T> {
  /** The latest answer. It stays on screen while a newer one, for the same key or another, is on its way. */
  data?: T;
  /** The key `data` answers. */
  dataKey?: string;
  /** The current key could not be loaded and there is nothing of it to show. */
  error?: string;
  loading: boolean;
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Loads once per `key` and again whenever `rev` changes (the working tree moved). The previous answer is kept until
 * the next one arrives, so a view never blinks through its drafting state on a refetch; when a refetch of the same
 * key fails the answer stays for good (a tab whose session ended shows its last content). An undefined key loads
 * nothing and forgets the answer.
 */
export function useFetched<T>(key: string | undefined, rev: number, load: (signal: AbortSignal) => Promise<T>): Fetched<T> {
  const [state, setState] = useState<{key?: string; data?: T; dataKey?: string; error?: string; loading: boolean}>({loading: false});
  const loader = useRef(load);
  loader.current = load;

  // `rev` is a refetch trigger, not an input of the request.
  useEffect(() => {
    if (key === undefined) {
      setState({loading: false});
      return;
    }
    const control = new AbortController();
    setState(prev => ({...prev, key, error: undefined, loading: true}));
    loader.current(control.signal).then(
      data => {
        if (!control.signal.aborted) setState({key, data, dataKey: key, loading: false});
      },
      error => {
        if (control.signal.aborted) return;
        setState(prev => (prev.dataKey === key ? {...prev, loading: false} : {key, error: errorText(error), loading: false}));
      },
    );
    return () => control.abort();
  }, [key, rev]);

  if (key === undefined) return {loading: false};
  if (state.key !== key) return {data: state.data, dataKey: state.dataKey, loading: true};
  return {data: state.data, dataKey: state.dataKey, error: state.error, loading: state.loading};
}
