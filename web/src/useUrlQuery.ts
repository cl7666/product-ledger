import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

type ParamValue = string | number | undefined;
type ParamRecord = Record<string, ParamValue>;

/**
 * 把列表页的筛选/分页/排序状态同步到 URL，做到刷新不丢、链接可分享。
 * defaults 必须是模块级常量（引用稳定），数字类型的默认值会按数字解析。
 */
export function useUrlQuery<T extends ParamRecord>(defaults: T) {
  const [searchParams, setSearchParams] = useSearchParams();

  const state = useMemo(() => {
    const next: ParamRecord = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const raw = searchParams.get(key);
      if (raw === null || raw === '') continue;
      if (typeof defaults[key] === 'number') {
        const num = Number(raw);
        if (Number.isFinite(num)) next[key] = num;
      } else {
        next[key] = raw;
      }
    }
    return next as T;
  }, [searchParams, defaults]);

  const patch = useCallback(
    (changes: Partial<T>) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined || value === '' || value === defaults[key]) params.delete(key);
            else params.set(key, String(value));
          }
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams, defaults],
  );

  return [state, patch] as const;
}
