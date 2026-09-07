'use client'

// ─── App settings hook (restaurant names, etc.) ─────────────────────

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, fetcher } from '@/lib/api'
import { RESTAURANT_NAME, RESTAURANT_NAME_AR } from '@/lib/constants'
import type { AppSettings } from '@/lib/types'

export const SETTINGS_QUERY_KEY = ['app-settings'] as const

/** Read the live app settings (falls back to the constants while loading). */
export function useAppSettings() {
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => fetcher<{ settings: AppSettings }>('/api/settings'),
    staleTime: 60_000,
  })
  return {
    query,
    settings: query.data?.settings,
    /** live name when loaded, constant fallback otherwise */
    restaurantName: query.data?.settings.restaurantName ?? RESTAURANT_NAME,
    /** live Arabic name when loaded (bilingual checks), constant fallback otherwise */
    restaurantNameAr: query.data?.settings.restaurantNameAr ?? RESTAURANT_NAME_AR,
  }
}

/** Mutation helper: update app settings (admin) and refresh the cache. */
export async function updateAppSettings(
  queryClient: ReturnType<typeof useQueryClient>,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const res = await apiFetch<{ settings: AppSettings }>('/api/settings', {
    method: 'PUT',
    body: patch,
  })
  await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY })
  return res.settings
}
