'use client'

// ─── Guest-move decision mutations (shared hook) ─────────────────────
// One implementation of confirm / reject / undo used by BOTH the vision
// Movements tab and the compact MovementQuickDialog (overview tiles +
// POS floor chips). AI suggestions only ever become real POS changes
// through these human-confirmed actions.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { MovementCandidateDTO } from '@/lib/types'

import { invalidateAfterMovementDecision } from './vision-utils'

export type MovementMode = 'table_and_order' | 'table_only'

export function useMovementDecisions() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const confirmMutation = useMutation({
    mutationFn: (vars: { id: number; mode: MovementMode; reason?: string }) =>
      apiFetch<{ movement: MovementCandidateDTO }>(`/api/vision/movements/${vars.id}/confirm`, {
        body: { mode: vars.mode, reason: vars.reason },
      }),
    onSuccess: async () => {
      toast.success(t('vision.movements.confirmedToast'))
      await invalidateAfterMovementDecision(queryClient)
    },
    onError: async (err: Error) => {
      // 409 → the live state changed under us (order closed/moved): surface
      // the server message and refetch so the card flips to conflict.
      toast.error(err.message)
      await invalidateAfterMovementDecision(queryClient)
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (vars: { id: number; reason?: string }) =>
      apiFetch<{ movement: MovementCandidateDTO }>(`/api/vision/movements/${vars.id}/reject`, {
        body: { reason: vars.reason },
      }),
    onSuccess: async () => {
      toast.success(t('vision.movements.rejectedToast'))
      await invalidateAfterMovementDecision(queryClient)
    },
    onError: async (err: Error) => {
      toast.error(err.message)
      await invalidateAfterMovementDecision(queryClient)
    },
  })

  const undoMutation = useMutation({
    mutationFn: (vars: { id: number; reason?: string }) =>
      apiFetch<{ movement: MovementCandidateDTO }>(`/api/vision/movements/${vars.id}/undo`, {
        body: { reason: vars.reason },
      }),
    onSuccess: async () => {
      toast.success(t('vision.movements.undoToast'))
      await invalidateAfterMovementDecision(queryClient)
    },
    onError: async (err: Error) => {
      toast.error(err.message)
      await invalidateAfterMovementDecision(queryClient)
    },
  })

  return { confirmMutation, rejectMutation, undoMutation }
}
