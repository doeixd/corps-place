import { useCallback, useState } from 'react';
import type { LatLng } from '@/lib/geo';

// Browser geolocation, request-on-demand. This is the one legitimate "external
// system" interaction (the Geolocation API), but it's driven by a user action
// (a button tap), not a mount effect — so there's no useEffect here at all:
// request() calls the API directly from the click handler and stores the result.
export type GeoState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'located'; coords: LatLng }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface UseGeolocation {
  state: GeoState;
  request: () => void;
}

export function useGeolocation(): UseGeolocation {
  const [state, setState] = useState<GeoState>({ status: 'idle' });

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState({ status: 'unsupported' });
      return;
    }
    setState({ status: 'locating' });
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setState({
          status: 'located',
          coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        }),
      (err) =>
        setState(
          err.code === err.PERMISSION_DENIED
            ? { status: 'denied' }
            : { status: 'error', message: err.message }
        ),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60_000 }
    );
  }, []);

  return { state, request };
}
