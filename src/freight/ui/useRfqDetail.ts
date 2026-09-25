'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RfqDetail } from '@/freight/view';
import type { RecipientOption } from '@/freight/service/rfq';

export interface RfqDetailBundle {
  detail: RfqDetail;
  recipientOptions: RecipientOption[];
}

/**
 * Loads one request. Kept separate from the workspace snapshot because the
 * detail is large and only one request is open at a time.
 */
export function useRfqDetail(rfqId: string, version: number) {
  const [data, setData] = useState<RfqDetailBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/freight/rfq/${encodeURIComponent(rfqId)}`, { cache: 'no-store' });
      const payload = (await res.json()) as RfqDetailBundle & { error?: string };
      if (!res.ok) {
        setError(payload.error ?? 'That request could not be loaded.');
        setData(null);
        return;
      }
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That request could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [rfqId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  return { data, loading, error, reload: load };
}
