'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GripVertical, MoreHorizontal, Pencil, Plus, Tags, Trash2, TriangleAlert } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { Category } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

// ─── Form state & validation ────────────────────────────────────────

type CategoryForm = {
  name: string
  displayOrder: string
}

type CategoryFormErrors = Partial<Record<'name' | 'displayOrder', string>>

function validateCategoryForm(
  form: CategoryForm,
  t: (key: string) => string,
): CategoryFormErrors {
  const errors: CategoryFormErrors = {}
  if (form.name.trim() === '') errors.name = t('admin.nameRequired')
  const order = Number(form.displayOrder)
  if (form.displayOrder.trim() === '' || !Number.isInteger(order) || order < 0) {
    errors.displayOrder = t('admin.orderWhole')
  }
  return errors
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

function BadgeOrder({ order }: { order: number }) {
  return (
    <Badge variant="outline" className="shrink-0 tabular-nums">
      {order}
    </Badge>
  )
}

// ─── View ───────────────────────────────────────────────────────────

export default function CategoriesView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Category | null>(null)
  const [form, setForm] = useState<CategoryForm>({ name: '', displayOrder: '0' })
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)

  const categoriesQuery = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => fetcher<{ categories: Category[] }>('/api/categories?all=1'),
  })

  const categories = useMemo(
    () =>
      [...(categoriesQuery.data?.categories ?? [])].sort(
        (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
      ),
    [categoriesQuery.data],
  )

  function nextDisplayOrder(): string {
    if (categories.length === 0) return '0'
    const max = categories.reduce((acc, c) => Math.max(acc, c.displayOrder), 0)
    return String(max + 1)
  }

  const isCreate = editing === null
  const errors = validateCategoryForm(form, t)
  const hasErrors = Object.values(errors).some(Boolean)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { name: form.name.trim(), displayOrder: Number(form.displayOrder) }
      return editing === null
        ? apiFetch<{ category: Category }>('/api/categories', { method: 'POST', body: payload })
        : apiFetch<{ category: Category }>(`/api/categories/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
      toast.success(editing === null ? t('admin.categoryCreated') : t('admin.categoryUpdated'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ category: Category }>(`/api/categories/${id}`, {
        method: 'PUT',
        body: { active },
      }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['categories'] })
      const prev = queryClient.getQueryData<{ categories: Category[] }>(['categories', 'all'])
      if (prev) {
        queryClient.setQueryData(['categories', 'all'], {
          categories: prev.categories.map((c) => (c.id === id ? { ...c, active } : c)),
        })
      }
      return { prev }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? t('admin.categoryActivated') : t('admin.categoryDeactivated'))
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['categories', 'all'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean }>(`/api/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
      toast.success(t('admin.categoryDeactivated'))
      setDeleteTarget(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function openCreate() {
    setEditing(null)
    setForm({ name: '', displayOrder: nextDisplayOrder() })
    setFormOpen(true)
  }

  function openEdit(category: Category) {
    setEditing(category)
    setForm({ name: category.name, displayOrder: String(category.displayOrder) })
    setFormOpen(true)
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('nav.categories')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin.categoriesSubtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('admin.newCategory')}
        </Button>
      </div>

      {/* Category rows */}
      <Card className="p-4">
        {categoriesQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                <Skeleton className="size-4" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-5 w-10" />
                <Skeleton className="size-11 rounded-md" />
              </div>
            ))}
          </div>
        ) : categoriesQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.loadCategoriesFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {categoriesQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void categoriesQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : categories.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Tags className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.noCategories')}</p>
              <p className="text-muted-foreground text-sm">{t('admin.noCategoriesHint')}</p>
            </div>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> {t('admin.newCategory')}
            </Button>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] space-y-2 overflow-y-auto">
            {categories.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3',
                  !c.active && 'bg-muted/40',
                )}
              >
                <GripVertical className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate font-medium', !c.active && 'text-muted-foreground')}>
                    {c.name}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {t('admin.productsCount', { count: c.productCount ?? 0 })}
                  </p>
                </div>
                <BadgeOrder order={c.displayOrder} />
                <Switch
                  checked={c.active}
                  disabled={toggleMutation.isPending && toggleMutation.variables?.id === c.id}
                  onCheckedChange={(checked) => toggleMutation.mutate({ id: c.id, active: checked })}
                  aria-label={`${c.active ? t('admin.deactivate') : t('admin.activate')} ${c.name}`}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 text-muted-foreground"
                      aria-label={t('admin.actionsFor', { name: c.name })}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openEdit(c)}>
                      <Pencil /> {t('common.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(c)}>
                      <Trash2 /> {t('common.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('admin.newCategory') : t('admin.editCategory')}</DialogTitle>
            <DialogDescription>{t('admin.categoryDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="category-name">
                {t('common.name')} *
              </Label>
              <Input
                id="category-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('admin.categoryPlaceholder')}
                className="h-11"
                aria-invalid={errors.name ? true : undefined}
              />
              <FieldError message={errors.name} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="category-order">{t('admin.displayOrder')}</Label>
              <Input
                id="category-order"
                type="number"
                step={1}
                min={0}
                inputMode="numeric"
                value={form.displayOrder}
                onChange={(e) => setForm({ ...form, displayOrder: e.target.value })}
                className="h-11"
                aria-invalid={errors.displayOrder ? true : undefined}
              />
              <p className="text-muted-foreground text-xs">{t('admin.displayOrderHint')}</p>
              <FieldError message={errors.displayOrder} />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setFormOpen(false)}
              disabled={saveMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? t('admin.saving') : isCreate ? t('admin.createCategory') : t('admin.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.deactivateCategory')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.deactivateCategoryDesc', { name: deleteTarget?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              className="h-11"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteMutation.isPending ? t('admin.deactivating') : t('admin.deactivate')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
