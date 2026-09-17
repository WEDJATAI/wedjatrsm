'use client'

// ─── R17 Purchasing module — Odoo-style suppliers + purchase orders ──
// Two tabs (Suppliers | Purchase Orders) inside the shared admin shell.
// Data flows through TanStack Query (['suppliers'], ['purchase-orders'],
// shared ['products']) with sonner toasts; receiving posts InventoryTransaction
// 'purchase' rows + last-purchase-price revaluation server-side.

import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronRight,
  ChevronsUpDown,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Truck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetch, fetcher } from '@/lib/api'
import { localizedName, useI18n } from '@/lib/i18n'
import type { Product, PurchaseOrderDTO, Supplier } from '@/lib/types'
import { formatCurrency, formatDate, formatDateTime, formatQty } from '@/lib/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'

// ── helpers ─────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100

/** component-local bilingual literals (strings missing from the r17 dict) */
type LocStr = { en: string; ar: string }
function L(s: LocStr, lang: string): string {
  return lang === 'ar' ? s.ar : s.en
}

const LOC = {
  supplierDirDesc: {
    en: 'Vendor directory — contacts, order history and lifetime purchases',
    ar: 'دليل الموردين — بيانات الاتصال وسجل الطلبات وإجمالي المشتريات',
  },
  stockTracked: { en: 'Stock-tracked items', ar: 'أصناف متتبعة في المخزون' },
  otherItems: { en: 'Other items', ar: 'أصناف أخرى' },
  noProductsFound: { en: 'No items match your search', ar: 'لا توجد أصناف مطابقة للبحث' },
  removeLine: { en: 'Remove line', ar: 'إزالة البند' },
  receivingNow: { en: 'Receiving now', ar: 'يُستلم الآن' },
  createPO: { en: 'Create PO', ar: 'إنشاء أمر الشراء' },
  lineTotalCol: { en: 'Line total', ar: 'إجمالي البند' },
  invalidQty: { en: 'Enter valid non-negative quantities', ar: 'أدخل كميات صحيحة غير سالبة' },
  editSupplierAria: { en: 'Edit supplier', ar: 'تعديل المورد' },
  deleteSupplierAria: { en: 'Delete supplier', ar: 'حذف المورد' },
  viewPOAria: { en: 'View purchase order', ar: 'عرض أمر الشراء' },
  partialReceiveHint: {
    en: 'Partially received — the PO stays “Ordered” until every line is complete. You can receive in multiple deliveries.',
    ar: 'استلام جزئي — يبقى الأمر «مطلوبًا» حتى اكتمال كل البنود. يمكنك الاستلام على عدة دفعات.',
  },
  loadFailed: { en: 'Failed to load data', ar: 'تعذر تحميل البيانات' },
} as const

const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'r17.po.statusDraft',
  ordered: 'r17.po.statusOrdered',
  received: 'r17.po.statusReceived',
  cancelled: 'r17.po.statusCancelled',
}

const PO_STATUS_STYLE: Record<string, string> = {
  draft: 'bg-secondary text-secondary-foreground',
  ordered: 'bg-amber-500/15 text-amber-600',
  received: 'bg-emerald-500/15 text-emerald-600',
  cancelled: 'bg-muted text-muted-foreground',
}

/** quantities within this tolerance count as fully received */
const QTY_EPSILON = 0.001

function useInvalidatePOs() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['purchase-orders'] })
    void qc.invalidateQueries({ queryKey: ['suppliers'] })
  }
}

/** stock/cost landed → refresh every inventory surface */
function useInvalidateStock() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['products'] })
    void qc.invalidateQueries({ queryKey: ['inventory'] })
    void qc.invalidateQueries({ queryKey: ['inventory-value'] })
    void qc.invalidateQueries({ queryKey: ['inventory-transactions'] })
  }
}

// ── shared state blocks ─────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  return (
    <Badge
      className={cn('border-transparent', PO_STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground')}
    >
      {PO_STATUS_LABEL[status] ? t(PO_STATUS_LABEL[status]) : status}
    </Badge>
  )
}

function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-200 bg-rose-50/60 p-6 text-center">
      <AlertTriangle className="size-8 text-rose-500" />
      <p className="text-sm text-rose-700">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw />
        {t('r17.common.retry')}
      </Button>
    </div>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  )
}

function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="size-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

// ─── main view ──────────────────────────────────────────────────────

export default function PurchasesView() {
  const { t } = useI18n()
  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('r17.purchasing.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('r17.purchasing.subtitle')}</p>
        </div>
      </div>

      <Tabs defaultValue="suppliers" className="gap-4">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="suppliers">
            <Truck />
            {t('r17.purchasing.tab.suppliers')}
          </TabsTrigger>
          <TabsTrigger value="orders">
            <PackageCheck />
            {t('r17.purchasing.tab.orders')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="suppliers">
          <SuppliersTab />
        </TabsContent>
        <TabsContent value="orders">
          <OrdersTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─── suppliers tab ──────────────────────────────────────────────────

function SuppliersTab() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [deleting, setDeleting] = useState<Supplier | null>(null)

  const suppliersQuery = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => fetcher<{ suppliers: Supplier[] }>('/api/suppliers'),
  })
  const suppliers = suppliersQuery.data?.suppliers ?? []

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: true }>(`/api/suppliers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('r17.purchasing.suppliers.deleted'))
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      setDeleting(null)
    },
    onError: (err: Error) => {
      // 409 race: server blocks suppliers with purchase history
      const msg = err.message ?? ''
      toast.error(
        msg.includes('cannot be deleted') ? t('r17.purchasing.suppliers.hasOrders') : msg,
      )
    },
  })

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t('r17.purchasing.tab.suppliers')}</CardTitle>
            <CardDescription>{L(LOC.supplierDirDesc, lang)}</CardDescription>
          </div>
          <Button
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus />
            {t('r17.purchasing.suppliers.add')}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        {suppliersQuery.isLoading ? (
          <ListSkeleton rows={5} />
        ) : suppliersQuery.isError ? (
          <QueryError
            message={
              (suppliersQuery.error as Error | null)?.message ?? L(LOC.loadFailed, lang)
            }
            onRetry={() => void suppliersQuery.refetch()}
          />
        ) : suppliers.length === 0 ? (
          <EmptyState icon={Truck} message={t('r17.purchasing.suppliers.empty')} />
        ) : (
          <>
            {/* desktop table */}
            <div className="max-h-96 overflow-y-auto rms-scroll">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('r17.purchasing.suppliers.name')}</TableHead>
                    <TableHead>
                      {t('r17.purchasing.suppliers.phone')} / {t('r17.purchasing.suppliers.email')}
                    </TableHead>
                    <TableHead className="text-end">{t('r17.purchasing.suppliers.poCount')}</TableHead>
                    <TableHead className="text-end">
                      {t('r17.purchasing.suppliers.totalPurchased')}
                    </TableHead>
                    <TableHead>{t('common.status')}</TableHead>
                    <TableHead className="text-end">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suppliers.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <p className="font-medium">{s.name}</p>
                        {s.address ? (
                          <p className="text-xs text-muted-foreground">{s.address}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{s.phone ?? '—'}</p>
                        <p className="text-xs text-muted-foreground">{s.email ?? ''}</p>
                      </TableCell>
                      <TableCell className="text-end font-mono">{s.purchaseCount}</TableCell>
                      <TableCell className="text-end font-mono">
                        {formatCurrency(s.totalPurchased)}
                      </TableCell>
                      <TableCell>
                        {s.active ? (
                          <Badge className="border-transparent bg-emerald-500/15 text-emerald-600">
                            {t('r17.common.active')}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{t('r17.common.inactive')}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => {
                              setEditing(s)
                              setFormOpen(true)
                            }}
                            aria-label={`${L(LOC.editSupplierAria, lang)}: ${s.name}`}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleting(s)}
                            aria-label={`${L(LOC.deleteSupplierAria, lang)}: ${s.name}`}
                          >
                            <Trash2 className="size-4 text-rose-500" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* mobile card list */}
            <div className="max-h-96 space-y-2 overflow-y-auto rms-scroll md:hidden">
              {suppliers.map((s) => (
                <div key={s.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.phone ?? s.email ?? '—'}
                      </p>
                    </div>
                    {s.active ? (
                      <Badge className="border-transparent bg-emerald-500/15 text-emerald-600">
                        {t('r17.common.active')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{t('r17.common.inactive')}</Badge>
                    )}
                  </div>
                  <div className="mt-2 flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">
                      {t('r17.purchasing.suppliers.poCount')}:{' '}
                      <span className="font-mono">{s.purchaseCount}</span>
                    </span>
                    <span className="font-mono">{formatCurrency(s.totalPurchased)}</span>
                  </div>
                  <div className="mt-2 flex justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(s)
                        setFormOpen(true)
                      }}
                    >
                      <Pencil />
                      {t('r17.common.edit')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setDeleting(s)}>
                      <Trash2 className="text-rose-500" />
                      {t('r17.common.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <SupplierFormDialog
        open={formOpen}
        supplier={editing}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
      />

      {/* delete confirm — blocked (and explained) while purchase history exists */}
      <AlertDialog
        open={deleting != null}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('r17.common.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? t('r17.purchasing.suppliers.deleteConfirm') : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleting && deleting.purchaseCount > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-700">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{t('r17.purchasing.suppliers.hasOrders')}</span>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t('r17.common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending || (deleting?.purchaseCount ?? 0) > 0}
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={(e) => {
                if (!deleting) return
                e.preventDefault() // stay open until the mutation settles
                deleteMutation.mutate(deleting.id)
              }}
            >
              {deleteMutation.isPending ? t('r17.common.loading') : t('r17.common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── supplier add / edit dialog ─────────────────────────────────────

function SupplierFormDialog({
  open,
  supplier,
  onClose,
}: {
  open: boolean
  supplier: Supplier | null
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {supplier ? t('r17.purchasing.suppliers.edit') : t('r17.purchasing.suppliers.add')}
          </DialogTitle>
        </DialogHeader>
        {open ? (
          <SupplierForm key={supplier?.id ?? 'new'} supplier={supplier} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function SupplierForm({
  supplier,
  onClose,
}: {
  supplier: Supplier | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [name, setName] = useState(supplier?.name ?? '')
  const [phone, setPhone] = useState(supplier?.phone ?? '')
  const [email, setEmail] = useState(supplier?.email ?? '')
  const [address, setAddress] = useState(supplier?.address ?? '')
  const [notes, setNotes] = useState(supplier?.notes ?? '')
  const [active, setActive] = useState(supplier?.active ?? true)
  const [nameError, setNameError] = useState(false)

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      supplier
        ? apiFetch<{ supplier: Supplier }>(`/api/suppliers/${supplier.id}`, {
            method: 'PUT',
            body,
          })
        : apiFetch<{ supplier: Supplier }>('/api/suppliers', { method: 'POST', body }),
    onSuccess: () => {
      toast.success(t('r17.purchasing.suppliers.saved'))
      void queryClient.invalidateQueries({ queryKey: ['suppliers'] })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setNameError(true)
      return
    }
    setNameError(false)
    saveMutation.mutate({
      name: name.trim(),
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      address: address.trim() || undefined,
      notes: notes.trim() || undefined,
      active,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="supplier-name">{t('r17.purchasing.suppliers.name')}</Label>
        <Input
          id="supplier-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameError}
          required
        />
        {nameError ? (
          <p className="text-xs text-rose-600">{t('r17.purchasing.suppliers.nameRequired')}</p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="supplier-phone">{t('r17.purchasing.suppliers.phone')}</Label>
          <Input
            id="supplier-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="supplier-email">{t('r17.purchasing.suppliers.email')}</Label>
          <Input
            id="supplier-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="supplier-address">{t('r17.purchasing.suppliers.address')}</Label>
        <Input
          id="supplier-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="supplier-notes">{t('r17.purchasing.suppliers.notes')}</Label>
        <Textarea
          id="supplier-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </div>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <Label htmlFor="supplier-active">{t('r17.common.active')}</Label>
        <Switch
          id="supplier-active"
          checked={active}
          onCheckedChange={setActive}
          aria-label={t('r17.common.active')}
        />
      </div>
      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('r17.common.cancel')}
        </Button>
        <Button type="submit" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? t('r17.common.loading') : t('r17.common.save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ─── purchase orders tab ────────────────────────────────────────────

function OrdersTab() {
  const { t, lang } = useI18n()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const poQuery = useQuery({
    queryKey: ['purchase-orders'],
    queryFn: () => fetcher<{ purchaseOrders: PurchaseOrderDTO[] }>('/api/purchase-orders'),
  })
  const orders = useMemo(
    () => poQuery.data?.purchaseOrders ?? [],
    [poQuery.data?.purchaseOrders],
  )
  const selected = useMemo(
    () => orders.find((o) => o.id === selectedId) ?? null,
    [orders, selectedId],
  )

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t('r17.purchasing.tab.orders')}</CardTitle>
            <CardDescription>{t('r17.po.statusLegend')}</CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            {t('r17.po.new')}
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        {poQuery.isLoading ? (
          <ListSkeleton rows={5} />
        ) : poQuery.isError ? (
          <QueryError
            message={(poQuery.error as Error | null)?.message ?? L(LOC.loadFailed, lang)}
            onRetry={() => void poQuery.refetch()}
          />
        ) : orders.length === 0 ? (
          <EmptyState icon={PackageCheck} message={t('r17.po.empty')} />
        ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto rms-scroll">
            {orders.map((po) => (
              <button
                key={po.id}
                type="button"
                onClick={() => setSelectedId(po.id)}
                aria-label={`${L(LOC.viewPOAria, lang)} ${po.number} — ${po.supplier.name}`}
                className="w-full rounded-xl text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="gap-3 p-4 transition-colors hover:bg-accent/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">{po.number}</span>
                        <StatusBadge status={po.status} />
                      </div>
                      <p className="mt-1 truncate text-sm font-medium">{po.supplier.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {po.createdBy ? `${t('r17.po.createdBy')}: ${po.createdBy} · ` : ''}
                        {formatDateTime(po.createdAt)}
                        {po.expectedAt
                          ? ` · ${t('r17.po.expectedAt')}: ${formatDate(po.expectedAt)}`
                          : ''}
                      </p>
                      {po.status === 'ordered' && po.outstanding > 0 ? (
                        <p className="text-xs text-amber-600">
                          {t('r17.po.outstanding')}: {formatCurrency(po.outstanding)}
                        </p>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="font-mono text-sm font-semibold">
                        {formatCurrency(po.total)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {po.lines.length} {t('r17.po.lines').toLowerCase()}
                      </p>
                      {po.receivedTotal > 0 ? (
                        <p className="text-xs text-emerald-600">
                          {formatCurrency(po.receivedTotal)}
                        </p>
                      ) : null}
                    </div>
                    <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}
      </Card>

      {selected ? (
        <PODetailDialog po={selected} onClose={() => setSelectedId(null)} />
      ) : null}

      <NewPODialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  )
}

// ─── PO detail dialog (lines + lifecycle actions) ───────────────────

function PODetailDialog({ po, onClose }: { po: PurchaseOrderDTO; onClose: () => void }) {
  const { t, lang } = useI18n()
  const invalidatePOs = useInvalidatePOs()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)

  const confirmMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ purchaseOrder: PurchaseOrderDTO }>(`/api/purchase-orders/${po.id}`, {
        method: 'PATCH',
        body: { action: 'confirm' },
      }),
    onSuccess: (data) => {
      toast.success(t('r17.po.confirmed', { number: data.purchaseOrder.number }))
      invalidatePOs()
      setConfirmOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ purchaseOrder: PurchaseOrderDTO }>(`/api/purchase-orders/${po.id}`, {
        method: 'PATCH',
        body: { action: 'cancel' },
      }),
    onSuccess: () => {
      toast.success(t('r17.po.cancelled'))
      invalidatePOs()
      setCancelOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) onClose()
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{po.number}</span>
              <StatusBadge status={po.status} />
            </DialogTitle>
            <DialogDescription>
              {po.supplier.name}
              {po.createdBy ? ` · ${t('r17.po.createdBy')}: ${po.createdBy}` : ''} ·{' '}
              {formatDateTime(po.createdAt)}
            </DialogDescription>
          </DialogHeader>

          {/* timestamps */}
          <div className="flex flex-wrap gap-1.5">
            {po.expectedAt ? (
              <Badge variant="outline">
                {t('r17.po.expectedAt')}: {formatDate(po.expectedAt)}
              </Badge>
            ) : null}
            {po.orderedAt ? (
              <Badge variant="outline">
                {t('r17.po.orderedAt')}: {formatDateTime(po.orderedAt)}
              </Badge>
            ) : null}
            {po.receivedAt ? (
              <Badge variant="outline" className="border-emerald-200 text-emerald-700">
                {t('r17.po.receivedAt')}: {formatDateTime(po.receivedAt)}
              </Badge>
            ) : null}
          </div>

          {/* line table */}
          <div className="max-h-96 overflow-y-auto rms-scroll rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('r17.po.lineProduct')}</TableHead>
                  <TableHead className="text-end">{t('r17.po.lineQty')}</TableHead>
                  <TableHead className="text-end">{t('r17.po.lineCost')}</TableHead>
                  <TableHead className="text-end">{t('r17.po.lineReceived')}</TableHead>
                  <TableHead className="text-end">{L(LOC.lineTotalCol, lang)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {po.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <p className="font-medium">
                        {localizedName(line.product.name, line.product.nameAr, lang)}
                      </p>
                      {line.product.sku ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          {line.product.sku}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {formatQty(line.quantity)}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {formatCurrency(line.unitCost)}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      <span
                        className={
                          line.receivedQuantity >= line.quantity - QTY_EPSILON
                            ? 'text-emerald-600'
                            : 'text-amber-600'
                        }
                      >
                        {formatQty(line.receivedQuantity)}
                      </span>
                      <span className="text-muted-foreground"> / {formatQty(line.quantity)}</span>
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {formatCurrency(line.lineTotal)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* totals */}
          <div className="grid gap-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('r17.po.total')}</span>
              <span className="font-mono font-semibold">{formatCurrency(po.total)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('r17.po.receivedTotal')}</span>
              <span className="font-mono text-emerald-600">
                {formatCurrency(po.receivedTotal)}
              </span>
            </div>
            {po.status !== 'cancelled' && po.outstanding > 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('r17.po.outstanding')}</span>
                <span className="font-mono text-amber-600">
                  {formatCurrency(po.outstanding)}
                </span>
              </div>
            ) : null}
          </div>

          {po.note ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                {t('r17.common.notes')}
              </p>
              <p className="mt-1">{po.note}</p>
            </div>
          ) : null}

          {/* status-appropriate actions */}
          {po.status === 'draft' || po.status === 'ordered' ? (
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button
                variant="outline"
                className="text-rose-600 hover:text-rose-700"
                onClick={() => setCancelOpen(true)}
              >
                <Ban />
                {t('r17.po.cancelPO')}
              </Button>
              {po.status === 'draft' ? (
                <Button onClick={() => setConfirmOpen(true)}>
                  <Check />
                  {t('r17.po.confirmOrder')}
                </Button>
              ) : (
                <Button onClick={() => setReceiveOpen(true)}>
                  <PackageCheck />
                  {t('r17.po.receive')}
                </Button>
              )}
            </DialogFooter>
          ) : po.status === 'received' ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-sm text-emerald-700">
              <CheckCircle2 className="size-4 shrink-0" />
              {t('r17.po.receivedAt')}: {po.receivedAt ? formatDateTime(po.receivedAt) : '—'}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              <Ban className="size-4 shrink-0" />
              {t('r17.po.statusCancelled')}
            </div>
          )}
          {po.status === 'ordered' && po.outstanding > 0 ? (
            <p className="text-xs text-muted-foreground">{L(LOC.partialReceiveHint, lang)}</p>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* confirm order */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('r17.po.confirmOrder')}</AlertDialogTitle>
            <AlertDialogDescription>{t('r17.po.confirmOrderDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmMutation.isPending}>
              {t('r17.common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                confirmMutation.mutate()
              }}
            >
              {confirmMutation.isPending ? t('r17.common.loading') : t('r17.po.confirmOrder')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* cancel PO */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('r17.po.cancelPO')}</AlertDialogTitle>
            <AlertDialogDescription>{t('r17.po.cancelConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              {t('r17.common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelMutation.isPending}
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={(e) => {
                e.preventDefault()
                cancelMutation.mutate()
              }}
            >
              {cancelMutation.isPending ? t('r17.common.loading') : t('r17.po.cancelPO')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReceiveDialog po={po} open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </>
  )
}

// ─── receive dialog (partial receiving supported) ───────────────────

function ReceiveDialog({
  po,
  open,
  onClose,
}: {
  po: PurchaseOrderDTO
  open: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('r17.po.receiveTitle')} — <span className="font-mono">{po.number}</span>
          </DialogTitle>
          <DialogDescription>{t('r17.po.receiveDesc')}</DialogDescription>
        </DialogHeader>
        {open ? <ReceiveForm key={po.id} po={po} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function ReceiveForm({ po, onClose }: { po: PurchaseOrderDTO; onClose: () => void }) {
  const { t, lang } = useI18n()
  const invalidatePOs = useInvalidatePOs()
  const invalidateStock = useInvalidateStock()

  const outstandingOf = (l: PurchaseOrderDTO['lines'][number]) =>
    Math.max(0, round2(l.quantity - l.receivedQuantity))

  /** per-line "receiving now" quantities, prefilled with the outstanding amount */
  const [inputs, setInputs] = useState<Record<number, string>>(() =>
    Object.fromEntries(po.lines.map((l) => [l.id, formatQty(outstandingOf(l))])),
  )

  const receiveMutation = useMutation({
    mutationFn: (lines: { lineId: number; receivedQty: number }[]) =>
      apiFetch<{ purchaseOrder: PurchaseOrderDTO }>(`/api/purchase-orders/${po.id}`, {
        method: 'PATCH',
        body: { action: 'receive', lines },
      }),
    onSuccess: (data) => {
      toast.success(t('r17.po.received'))
      invalidatePOs()
      invalidateStock()
      if (data.purchaseOrder.status === 'received') {
        toast.success(t('r17.po.statusReceived'), { description: po.number })
      }
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /** valid receiving-now entries (clamped to the outstanding amount) */
  const receiving = useMemo(
    () =>
      po.lines
        .map((l) => {
          const raw = Number(inputs[l.id])
          const qty =
            Number.isFinite(raw) && raw > 0 ? Math.min(round2(raw), outstandingOf(l)) : 0
          return { line: l, qty }
        })
        .filter((r) => r.qty > 0),
    [po.lines, inputs],
  )
  const totalUnits = round2(receiving.reduce((s, r) => s + r.qty, 0))
  const totalValue = round2(receiving.reduce((s, r) => s + r.qty * r.line.unitCost, 0))

  function receiveAll() {
    setInputs(Object.fromEntries(po.lines.map((l) => [l.id, formatQty(outstandingOf(l))])))
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    for (const l of po.lines) {
      const raw = Number(inputs[l.id])
      if (!Number.isFinite(raw) || raw < 0) {
        toast.error(L(LOC.invalidQty, lang))
        return
      }
    }
    if (receiving.length === 0) return
    // the API expects the NEW CUMULATIVE received total per line
    receiveMutation.mutate(
      po.lines.map((l) => {
        const raw = Number(inputs[l.id])
        const extra = Number.isFinite(raw) && raw > 0 ? Math.min(round2(raw), outstandingOf(l)) : 0
        return { lineId: l.id, receivedQty: round2(l.receivedQuantity + extra) }
      }),
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{L(LOC.partialReceiveHint, lang)}</p>
        <Button type="button" variant="outline" size="sm" onClick={receiveAll}>
          <PackageCheck />
          {t('r17.po.receiveFull')}
        </Button>
      </div>

      <div className="max-h-72 divide-y overflow-y-auto rms-scroll rounded-lg border">
        {po.lines.map((l) => (
          <div key={l.id} className="flex items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {localizedName(l.product.name, l.product.nameAr, lang)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('r17.po.lineQty')}: {formatQty(l.quantity)} · {t('r17.po.lineReceived')}:{' '}
                {formatQty(l.receivedQuantity)}
              </p>
            </div>
            <div className="w-28 shrink-0">
              <Label htmlFor={`recv-${l.id}`} className="sr-only">
                {L(LOC.receivingNow, lang)}
              </Label>
              <Input
                id={`recv-${l.id}`}
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                className="font-mono"
                value={inputs[l.id] ?? ''}
                onChange={(e) =>
                  setInputs((prev) => ({ ...prev, [l.id]: e.target.value }))
                }
              />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">
          {L(LOC.receivingNow, lang)} ({receiving.length}/{po.lines.length})
        </span>
        <span className="font-mono font-medium">
          +{formatQty(totalUnits)} · {formatCurrency(totalValue)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t('r17.po.receiptAudit')}</p>

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('r17.common.cancel')}
        </Button>
        <Button type="submit" disabled={receiveMutation.isPending || receiving.length === 0}>
          {receiveMutation.isPending
            ? t('r17.common.loading')
            : `${t('r17.po.receive')} (+${formatQty(totalUnits)})`}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ─── new PO dialog (line editor + live totals) ──────────────────────

type DraftLine = { key: number; productId: number | null; quantity: string; unitCost: string }

function NewPODialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('r17.po.new')}</DialogTitle>
          <DialogDescription>{t('r17.po.statusLegend')}</DialogDescription>
        </DialogHeader>
        {open ? <POForm onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function POForm({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n()
  const invalidatePOs = useInvalidatePOs()
  const [supplierId, setSupplierId] = useState('')
  const [note, setNote] = useState('')
  const [expectedAt, setExpectedAt] = useState('') // YYYY-MM-DD
  const [lines, setLines] = useState<DraftLine[]>([
    { key: 1, productId: null, quantity: '1', unitCost: '' },
  ])
  const keyRef = useRef(2)

  const suppliersQuery = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => fetcher<{ suppliers: Supplier[] }>('/api/suppliers'),
  })
  const productsQuery = useQuery({
    queryKey: ['products'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products'),
  })

  const activeSuppliers = useMemo(
    () => (suppliersQuery.data?.suppliers ?? []).filter((s) => s.active),
    [suppliersQuery.data?.suppliers],
  )

  // stock-tracked items first, then everything else (both by name)
  const { stockable, others } = useMemo(() => {
    const products = [...(productsQuery.data?.products ?? [])].sort(
      (a, b) =>
        Number(b.isStockable) - Number(a.isStockable) || a.name.localeCompare(b.name),
    )
    return {
      stockable: products.filter((p) => p.isStockable),
      others: products.filter((p) => !p.isStockable),
    }
  }, [productsQuery.data?.products])

  const liveTotal = useMemo(
    () =>
      round2(
        lines.reduce((sum, l) => {
          if (l.productId == null) return sum
          const q = Number(l.quantity)
          const c = Number(l.unitCost)
          return sum + (Number.isFinite(q) && Number.isFinite(c) ? q * c : 0)
        }, 0),
      ),
    [lines],
  )

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ purchaseOrder: PurchaseOrderDTO }>('/api/purchase-orders', {
        method: 'POST',
        body,
      }),
    onSuccess: (data) => {
      toast.success(t('r17.po.created', { number: data.purchaseOrder.number }))
      invalidatePOs()
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function addLine() {
    setLines((prev) => [
      ...prev,
      { key: keyRef.current++, productId: null, quantity: '1', unitCost: '' },
    ])
  }

  function removeLine(key: number) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev))
  }

  function selectProduct(key: number, p: Product) {
    setLines((prev) =>
      prev.map((l) =>
        l.key === key ? { ...l, productId: p.id, unitCost: String(p.cost ?? 0) } : l,
      ),
    )
  }

  function updateLine(key: number, patch: Partial<Pick<DraftLine, 'quantity' | 'unitCost'>>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!supplierId) {
      toast.error(t('r17.po.needSupplier'))
      return
    }
    const payloadLines: { productId: number; quantity: number; unitCost: number }[] = []
    for (const l of lines) {
      if (l.productId == null) continue
      const q = Number(l.quantity)
      const c = Number(l.unitCost)
      if (!Number.isFinite(q) || q <= 0) continue
      payloadLines.push({
        productId: l.productId,
        quantity: q,
        unitCost: Number.isFinite(c) && c >= 0 ? c : 0,
      })
    }
    const hasInvalidRow = lines.some(
      (l) => l.productId != null && !(Number.isFinite(Number(l.quantity)) && Number(l.quantity) > 0),
    )
    if (hasInvalidRow || payloadLines.length === 0) {
      toast.error(t('r17.po.needLines'))
      return
    }
    createMutation.mutate({
      supplierId: Number(supplierId),
      note: note.trim() || undefined,
      // noon anchor keeps the date stable in every timezone
      expectedAt: expectedAt ? `${expectedAt}T12:00:00` : undefined,
      lines: payloadLines,
    })
  }

  if (suppliersQuery.isError || productsQuery.isError) {
    return (
      <QueryError
        message={
          (suppliersQuery.error as Error | null)?.message ??
          (productsQuery.error as Error | null)?.message ??
          L(LOC.loadFailed, lang)
        }
        onRetry={() => {
          void suppliersQuery.refetch()
          void productsQuery.refetch()
        }}
      />
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="po-supplier">{t('r17.po.supplier')}</Label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger id="po-supplier" className="w-full">
              <SelectValue placeholder={t('r17.po.needSupplier')} />
            </SelectTrigger>
            <SelectContent>
              {activeSuppliers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="po-expected">{t('r17.po.expectedAt')}</Label>
          <Input
            id="po-expected"
            type="date"
            value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t('r17.po.lines')}</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus />
            {t('r17.po.addLine')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('r17.po.noStockableHint')}</p>

        <div className="space-y-2">
          {lines.map((l) => (
            <div
              key={l.key}
              className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_5rem_6.5rem_auto] sm:items-start"
            >
              <div className="min-w-0 space-y-1.5">
                <Label className="text-xs">{t('r17.po.lineProduct')}</Label>
                <ProductPicker
                  value={l.productId}
                  stockable={stockable}
                  others={others}
                  onSelect={(p) => selectProduct(l.key, p)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`po-qty-${l.key}`} className="text-xs">
                  {t('r17.po.lineQty')}
                </Label>
                <Input
                  id={`po-qty-${l.key}`}
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  className="font-mono"
                  value={l.quantity}
                  onChange={(e) => updateLine(l.key, { quantity: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`po-cost-${l.key}`} className="text-xs">
                  {t('r17.po.lineCost')}
                </Label>
                <Input
                  id={`po-cost-${l.key}`}
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  className="font-mono"
                  value={l.unitCost}
                  onChange={(e) => updateLine(l.key, { unitCost: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <div className="flex items-center sm:pt-7">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLine(l.key)}
                  disabled={lines.length === 1}
                  aria-label={L(LOC.removeLine, lang)}
                >
                  <Trash2 className="size-4 text-rose-500" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="po-note">{t('r17.common.notes')}</Label>
        <Input
          id="po-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('r17.purchasing.suppliers.notes')}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <span className="text-muted-foreground">{t('r17.po.total')}</span>
        <span className="font-mono text-base font-semibold">{formatCurrency(liveTotal)}</span>
      </div>

      <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          {t('r17.common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={
            createMutation.isPending || suppliersQuery.isLoading || productsQuery.isLoading
          }
        >
          {createMutation.isPending ? t('r17.common.loading') : L(LOC.createPO, lang)}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ─── searchable product picker (Popover + Command combobox) ─────────

function ProductPicker({
  value,
  stockable,
  others,
  onSelect,
}: {
  value: number | null
  stockable: Product[]
  others: Product[]
  onSelect: (p: Product) => void
}) {
  const { t, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const all = useMemo(() => [...stockable, ...others], [stockable, others])
  const selected = all.find((p) => p.id === value) ?? null

  function renderGroup(products: Product[]) {
    return products.map((p) => (
      <CommandItem
        key={p.id}
        value={`${p.name} ${p.sku ?? ''} ${p.nameAr ?? ''}`}
        onSelect={() => {
          onSelect(p)
          setOpen(false)
        }}
      >
        <Check className={cn('size-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')} />
        <span className="min-w-0 flex-1 truncate">
          {localizedName(p.name, p.nameAr, lang)}
        </span>
        {p.sku ? (
          <span className="ms-auto font-mono text-xs text-muted-foreground">{p.sku}</span>
        ) : null}
      </CommandItem>
    ))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selected ? localizedName(selected.name, selected.nameAr, lang) : t('r17.po.selectProduct')}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-3rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('r17.common.search')} />
          <CommandList className="max-h-64">
            <CommandEmpty>{L(LOC.noProductsFound, lang)}</CommandEmpty>
            {stockable.length > 0 ? (
              <CommandGroup heading={L(LOC.stockTracked, lang)}>
                {renderGroup(stockable)}
              </CommandGroup>
            ) : null}
            {others.length > 0 ? (
              <CommandGroup heading={L(LOC.otherItems, lang)}>{renderGroup(others)}</CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
