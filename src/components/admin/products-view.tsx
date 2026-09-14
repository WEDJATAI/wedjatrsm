'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  Loader2,
  MoreHorizontal,
  Package,
  PackageSearch,
  Pencil,
  Plus,
  Search,
  Store,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency, formatQty } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { ALLERGENS, DIETARY_TAGS } from '@/lib/constants'
import type { Category, ModifierGroupDTO, Product } from '@/lib/types'
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
import { Checkbox } from '@/components/ui/checkbox'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// ─── Form state & validation ────────────────────────────────────────

type ProductForm = {
  name: string
  nameAr: string // '' = no Arabic name (clears it)
  categoryId: string // '' = no category
  price: string
  cost: string
  isSellable: boolean
  isStockable: boolean
  sku: string
  imageUrl: string
  lowStockThreshold: string
  stock: string // create only
  allergens: string[] // R8: allergen tag keys
  dietary: string[] // R8: dietary tag keys
  modifierGroupIds: number[] // R8: attached option groups
}

type ProductFormErrors = Partial<
  Record<'name' | 'price' | 'cost' | 'lowStockThreshold' | 'stock', string>
>

const EMPTY_PRODUCT_FORM: ProductForm = {
  name: '',
  nameAr: '',
  categoryId: '',
  price: '',
  cost: '',
  isSellable: true,
  isStockable: false,
  sku: '',
  imageUrl: '',
  lowStockThreshold: '10',
  stock: '',
  allergens: [],
  dietary: [],
  modifierGroupIds: [],
}

function toProductForm(p: Product): ProductForm {
  return {
    name: p.name,
    nameAr: p.nameAr ?? '',
    categoryId: p.categoryId === null ? '' : String(p.categoryId),
    price: String(p.price),
    cost: String(p.cost),
    isSellable: p.isSellable,
    isStockable: p.isStockable,
    sku: p.sku ?? '',
    imageUrl: p.imageUrl ?? '',
    lowStockThreshold: String(p.lowStockThreshold),
    stock: String(p.stock),
    allergens: p.allergens ?? [],
    dietary: p.dietary ?? [],
    modifierGroupIds: (p.modifierGroups ?? []).map((g) => g.id),
  }
}

function validateProductForm(
  form: ProductForm,
  isCreate: boolean,
  t: (key: string) => string,
): ProductFormErrors {
  const errors: ProductFormErrors = {}
  if (form.name.trim() === '') errors.name = t('admin.nameRequired')
  const price = Number(form.price)
  if (form.price.trim() === '' || !Number.isFinite(price) || price < 0) {
    errors.price = t('admin.priceMin')
  }
  if (form.cost.trim() !== '') {
    const cost = Number(form.cost)
    if (!Number.isFinite(cost) || cost < 0) errors.cost = t('admin.costMin')
  }
  if (form.isStockable) {
    if (form.lowStockThreshold.trim() !== '') {
      const threshold = Number(form.lowStockThreshold)
      if (!Number.isFinite(threshold) || threshold < 0) {
        errors.lowStockThreshold = t('admin.mustBe0')
      }
    }
    if (isCreate && form.stock.trim() !== '') {
      const stock = Number(form.stock)
      if (!Number.isFinite(stock) || stock < 0) errors.stock = t('admin.mustBe0')
    }
  }
  return errors
}

// ─── Small presentational helpers ───────────────────────────────────

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

function SwitchRow({
  id,
  label,
  helper,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  helper: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{helper}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function stockColorClass(product: Product): string | undefined {
  if (!product.isStockable) return undefined
  if (product.stock <= product.lowStockThreshold) {
    return 'font-medium text-rose-600 dark:text-rose-400'
  }
  if (product.stock <= product.lowStockThreshold * 2) {
    return 'font-medium text-amber-600 dark:text-amber-500'
  }
  return undefined
}

function MarginCell({ product }: { product: Product }) {
  if (product.price <= 0) return <span className="text-muted-foreground">—</span>
  const margin = ((product.price - product.cost) / product.price) * 100
  const color =
    margin > 40
      ? 'text-emerald-600 dark:text-emerald-400'
      : margin >= 20
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-rose-600 dark:text-rose-400'
  return <span className={cn('text-xs font-medium tabular-nums', color)}>{Math.round(margin)}%</span>
}

function StockCell({ product }: { product: Product }) {
  if (!product.isStockable) return <span className="text-muted-foreground">—</span>
  return <span className={cn('tabular-nums', stockColorClass(product))}>{formatQty(product.stock)}</span>
}

/** R11: inline quick price edit — click the price (or its pencil) to turn
 *  the cell into a small input; ✓/Enter saves (PUT {price}), ✗/Esc cancels.
 *  Validates finite ≥ 0, rounds to 2dp, and is a silent no-op when the
 *  value did not change. */
function QuickPriceCell({
  product,
  editValue,
  saving,
  onStart,
  onChange,
  onConfirm,
  onCancel,
  t,
}: {
  product: Product
  editValue: string | null
  saving: boolean
  onStart: () => void
  onChange: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
  t: (key: string) => string
}) {
  const editing = editValue != null
  if (editing) {
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Input
          type="number"
          step={0.01}
          min={0}
          inputMode="decimal"
          value={editValue}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onConfirm()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
          autoFocus
          aria-label={t('admin.quickEditPrice')}
          className="h-11 w-24 text-right text-sm font-semibold tabular-nums"
        />
        <Button
          size="icon"
          className="size-11 shrink-0 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
          disabled={saving}
          onClick={onConfirm}
          title={t('admin.priceEditConfirm')}
          aria-label={t('admin.priceEditConfirm')}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-11 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
          disabled={saving}
          onClick={onCancel}
          title={t('admin.priceEditCancel')}
          aria-label={t('admin.priceEditCancel')}
        >
          <X className="size-4" />
        </Button>
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onStart}
      title={t('admin.quickEditPrice')}
      aria-label={`${t('admin.quickEditPrice')} — ${product.name}`}
      className="inline-flex h-11 items-center gap-1.5 rounded-lg px-1.5 text-sm font-medium tabular-nums transition-colors hover:bg-muted/60 hover:text-primary"
    >
      {formatCurrency(product.price)}
      <Pencil className="size-3.5 text-muted-foreground/60" aria-hidden />
    </button>
  )
}

function FlagIcon({
  active,
  icon: Icon,
  label,
}: {
  active: boolean
  icon: LucideIcon
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex size-6 items-center justify-center', active ? 'text-primary' : 'text-muted-foreground/30')}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function ActiveBadge({ active, label }: { active: boolean; label: { active: string; inactive: string } }) {
  if (!active)
    return (
      <Badge variant="outline" className="text-muted-foreground">
        {label.inactive}
      </Badge>
    )
  return (
    <Badge
      variant="outline"
      className="border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
    >
      {label.active}
    </Badge>
  )
}

/** Amber outline badge for untranslated items — Arabic mode only. */
function MissingArBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 border-amber-500/40 px-1.5 text-[10px] font-medium text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
    >
      {label}
    </Badge>
  )
}

// ─── R8: allergen / dietary tag chips + list badges ─────────────────

const ALLERGEN_CHIP_SELECTED =
  'border-rose-600/50 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/10 dark:text-rose-400'
const DIETARY_CHIP_SELECTED =
  'border-emerald-600/50 bg-emerald-50 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/10 dark:text-emerald-400'

/** Toggleable tag chip (form) — selected = filled outline, unselected = muted outline. */
function TagChip({
  label,
  selected,
  tone,
  onToggle,
}: {
  label: string
  selected: boolean
  tone: 'warning' | 'success'
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        'h-11 rounded-full border px-4 text-sm font-medium transition-colors',
        selected
          ? tone === 'warning'
            ? ALLERGEN_CHIP_SELECTED
            : DIETARY_CHIP_SELECTED
          : 'text-muted-foreground hover:bg-muted/50',
      )}
    >
      {label}
    </button>
  )
}

/** Compact allergen + dietary badges on product rows — max 2 each, then "+n". */
function ProductTagBadges({
  product,
  t,
}: {
  product: Product
  t: (key: string) => string
}) {
  const allergens = product.allergens ?? []
  const dietary = product.dietary ?? []
  if (allergens.length === 0 && dietary.length === 0) return null
  const extraAllergens = allergens.slice(2)
  const extraDietary = dietary.slice(2)
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {allergens.slice(0, 2).map((a) => (
        <Badge
          key={a}
          variant="outline"
          className="h-5 border-rose-600/30 px-1.5 text-[10px] font-medium text-rose-700 dark:border-rose-500/30 dark:text-rose-400"
        >
          {t(`allergen.${a}`)}
        </Badge>
      ))}
      {extraAllergens.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="h-5 border-rose-600/30 px-1.5 text-[10px] font-medium text-rose-700 dark:border-rose-500/30 dark:text-rose-400">
              +{extraAllergens.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{extraAllergens.map((a) => t(`allergen.${a}`)).join(', ')}</TooltipContent>
        </Tooltip>
      )}
      {dietary.slice(0, 2).map((d) => (
        <Badge
          key={d}
          variant="outline"
          className="h-5 border-emerald-600/30 px-1.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400"
        >
          {t(`dietary.${d}`)}
        </Badge>
      ))}
      {extraDietary.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="h-5 border-emerald-600/30 px-1.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-400">
              +{extraDietary.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{extraDietary.map((d) => t(`dietary.${d}`)).join(', ')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** Product display name — Arabic primary when the UI is Arabic (falls back to English). */
function ProductDisplayName({
  product,
  lang,
  missingArLabel,
}: {
  product: Product
  lang: 'en' | 'ar'
  missingArLabel: string
}) {
  const localized = localizedName(product.name, product.nameAr, lang)
  const missingAr = lang === 'ar' && !(product.nameAr ?? '').trim()
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{localized}</span>
      {missingAr && <MissingArBadge label={missingArLabel} />}
    </div>
  )
}

function ProductRowActions({
  product,
  onEdit,
  onDelete,
  labels,
}: {
  product: Product
  onEdit: (product: Product) => void
  onDelete: (product: Product) => void
  labels: { actionsFor: string; edit: string; delete: string }
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 text-muted-foreground"
          aria-label={labels.actionsFor}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onEdit(product)}>
          <Pencil /> {labels.edit}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onDelete(product)}>
          <Trash2 /> {labels.delete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── View ───────────────────────────────────────────────────────────

export default function ProductsView() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [showInactive, setShowInactive] = useState(false)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT_FORM)

  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)

  // R11: quick price edit — { productId, raw input text } while editing.
  const [priceEdit, setPriceEdit] = useState<{ id: number; value: string } | null>(null)

  const productsQuery = useQuery({
    queryKey: ['products', { all: showInactive, category: categoryFilter }],
    queryFn: () =>
      fetcher<{ products: Product[] }>(
        `/api/products?${new URLSearchParams({
          ...(showInactive ? { all: '1' } : {}),
          ...(categoryFilter !== 'all' ? { category: categoryFilter } : {}),
        }).toString()}`,
      ),
  })

  const categoriesQuery = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => fetcher<{ categories: Category[] }>('/api/categories?all=1'),
  })

  const modifierGroupsQuery = useQuery({
    queryKey: ['modifier-groups'],
    queryFn: () => fetcher<{ groups: ModifierGroupDTO[] }>('/api/modifier-groups'),
  })

  const activeModifierGroups = useMemo(
    () =>
      [...(modifierGroupsQuery.data?.groups ?? [])]
        .filter((g) => g.active)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [modifierGroupsQuery.data],
  )

  const categories = useMemo(
    () =>
      [...(categoriesQuery.data?.categories ?? [])].sort(
        (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
      ),
    [categoriesQuery.data],
  )

  const products = useMemo(() => {
    const items = productsQuery.data?.products ?? []
    const q = search.trim().toLowerCase()
    const filtered =
      q === ''
        ? items
        : items.filter(
            (p) => p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q),
          )
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
  }, [productsQuery.data, search])

  const isCreate = editing === null
  const errors = validateProductForm(form, isCreate, t)
  const hasErrors = Object.values(errors).some(Boolean)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim(),
        price: Number(form.price),
        cost: form.cost.trim() === '' ? 0 : Number(form.cost),
        isSellable: form.isSellable,
        isStockable: form.isStockable,
        allergens: form.allergens,
        dietary: form.dietary,
        // sorted by the group's display order when the list is loaded
        modifierGroupIds: [...form.modifierGroupIds].sort(
          (a, b) =>
            (activeModifierGroups.find((g) => g.id === a)?.sortOrder ?? a) -
            (activeModifierGroups.find((g) => g.id === b)?.sortOrder ?? b),
        ),
      }
      if (form.categoryId !== '') payload.categoryId = Number(form.categoryId)
      if (form.sku.trim() !== '') payload.sku = form.sku.trim()
      if (form.imageUrl.trim() !== '') payload.imageUrl = form.imageUrl.trim()
      if (form.isStockable) {
        payload.lowStockThreshold =
          form.lowStockThreshold.trim() === '' ? 0 : Number(form.lowStockThreshold)
        if (editing === null) {
          payload.stock = form.stock.trim() === '' ? 0 : Number(form.stock)
        }
      }
      return editing === null
        ? apiFetch<{ product: Product }>('/api/products', { method: 'POST', body: payload })
        : apiFetch<{ product: Product }>(`/api/products/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      // attachments changed → group product counts are stale
      void queryClient.invalidateQueries({ queryKey: ['modifier-groups'] })
      toast.success(editing === null ? t('admin.productCreated') : t('admin.productUpdated'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean }>(`/api/products/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(t('admin.productDeactivated'))
      setDeleteTarget(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // R11: inline quick price edit — partial update {price} only.
  const quickPriceMutation = useMutation({
    mutationFn: (vars: { id: number; price: number }) =>
      apiFetch<{ product: Product }>(`/api/products/${vars.id}`, {
        method: 'PUT',
        body: { price: vars.price },
      }),
    onSuccess: (_data, vars) => {
      toast.success(t('admin.priceUpdated'))
      setPriceEdit(null)
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // R13: "86" sold-out quick toggle from the admin list (mirrors the POS tile).
  const soldOutMutation = useMutation({
    mutationFn: (vars: { id: number; soldOut: boolean }) =>
      apiFetch<{ product: { id: number; soldOut: boolean } }>(
        `/api/products/${vars.id}/sold-out`,
        { method: 'PATCH', body: { soldOut: vars.soldOut } },
      ),
    onSuccess: (_data, vars) => {
      toast.success(vars.soldOut ? t('pos.soldOutToast', { name: '' }) : t('pos.availableToast', { name: '' }))
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      void queryClient.invalidateQueries({ queryKey: ['pos-products'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const confirmQuickPrice = (product: Product) => {
    if (priceEdit == null || priceEdit.id !== product.id) return
    const parsed = Number(priceEdit.value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error(t('admin.priceInvalid'))
      return
    }
    const next = Math.round(parsed * 100) / 100
    if (Math.abs(next - product.price) < 0.005) {
      setPriceEdit(null) // unchanged — silent no-op
      return
    }
    quickPriceMutation.mutate({ id: product.id, price: next })
  }

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_PRODUCT_FORM)
    setFormOpen(true)
  }

  function openEdit(product: Product) {
    setEditing(product)
    setForm(toProductForm(product))
    setFormOpen(true)
  }

  // R8 form toggles
  function toggleTag(
    key: 'allergens' | 'dietary',
    value: string,
  ) {
    setForm((f) => {
      const current = f[key]
      return {
        ...f,
        [key]: current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value],
      }
    })
  }

  function toggleModifierGroup(id: number, checked: boolean) {
    setForm((f) => ({
      ...f,
      modifierGroupIds: checked
        ? [...f.modifierGroupIds, id]
        : f.modifierGroupIds.filter((v) => v !== id),
    }))
  }

  const hasActiveFilters = search.trim() !== '' || categoryFilter !== 'all'

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('nav.products')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin.productsSubtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('admin.newProduct')}
        </Button>
      </div>

      {/* Toolbar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('admin.searchProduct')}
              className="h-11 ps-9"
              aria-label={t('admin.searchProduct')}
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-11 w-full sm:w-52" aria-label={t('admin.allCategories')}>
              <SelectValue placeholder={t('admin.allCategories')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin.allCategories')}</SelectItem>
              {categories.map((c) => (
                <SelectItem
                  key={c.id}
                  value={String(c.id)}
                  className={c.active ? undefined : 'text-muted-foreground'}
                >
                  {c.name}
                  {c.active ? '' : ` ${t('admin.inactiveSuffix')}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex h-11 items-center gap-2 rounded-md border px-3">
            <Switch
              id="products-show-inactive"
              checked={showInactive}
              onCheckedChange={setShowInactive}
            />
            <Label htmlFor="products-show-inactive" className="cursor-pointer text-sm">
              {t('admin.showInactive')}
            </Label>
          </div>
        </div>
      </Card>

      {/* Content */}
      <Card className="p-4">
        {productsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-4 w-16" />
                <Skeleton className="size-11 rounded-md" />
              </div>
            ))}
          </div>
        ) : productsQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.loadProductsFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {productsQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button variant="outline" className="h-11" onClick={() => void productsQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : products.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <PackageSearch className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.noProducts')}</p>
              <p className="text-muted-foreground text-sm">
                {hasActiveFilters ? t('admin.noProductsFilters') : t('admin.noProductsCreate')}
              </p>
              {/* R13: empty-state coaching (learnability) */}
              {!hasActiveFilters && (
                <p className="mt-1 text-sm text-muted-foreground/80">{t('products.emptyHint')}</p>
              )}
            </div>
            {!hasActiveFilters && (
              <Button className="h-11" onClick={openCreate}>
                <Plus /> {t('admin.newProduct')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Desktop / tablet table */}
            <div className="hidden md:block">
              <div className="rms-scroll max-h-[520px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('admin.product')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('admin.category')}</TableHead>
                      <TableHead className="text-end">{t('common.price')}</TableHead>
                      <TableHead className="hidden text-end lg:table-cell">{t('common.cost')}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t('admin.margin')}</TableHead>
                      <TableHead className="hidden text-end md:table-cell">{t('admin.colStock')}</TableHead>
                      <TableHead className="hidden lg:table-cell">{t('admin.colFlags')}</TableHead>
                      {/* R13: 86 sold-out quick toggle column */}
                      <TableHead className="hidden md:table-cell">{t('pos.86')}</TableHead>
                      <TableHead className="hidden md:table-cell">{t('common.active')}</TableHead>
                      <TableHead className="w-12 text-end">
                        <span className="sr-only">{t('common.actions')}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((p) => (
                      <TableRow key={p.id} className="h-14">
                        <TableCell>
                          <ProductDisplayName product={p} lang={lang} missingArLabel={t('admin.missingAr')} />
                          {lang === 'ar' && p.name !== localizedName(p.name, p.nameAr, lang) ? (
                            <div className="text-muted-foreground text-xs">{p.name}</div>
                          ) : null}
                          {p.sku ? (
                            <div className="font-mono text-muted-foreground text-xs">{p.sku}</div>
                          ) : null}
                          <ProductTagBadges product={p} t={t} />
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {p.category ? (
                            <Badge variant="outline">{p.category.name}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          <QuickPriceCell
                            product={p}
                            editValue={priceEdit?.id === p.id ? priceEdit.value : null}
                            saving={quickPriceMutation.isPending && quickPriceMutation.variables?.id === p.id}
                            t={t}
                            onStart={() => setPriceEdit({ id: p.id, value: String(p.price) })}
                            onChange={(v) => setPriceEdit({ id: p.id, value: v })}
                            onConfirm={() => confirmQuickPrice(p)}
                            onCancel={() => setPriceEdit(null)}
                          />
                        </TableCell>
                        <TableCell className="hidden text-end text-muted-foreground tabular-nums lg:table-cell">
                          {formatCurrency(p.cost)}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <MarginCell product={p} />
                        </TableCell>
                        <TableCell className="hidden text-end md:table-cell">
                          <StockCell product={p} />
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <div className="flex items-center gap-1">
                            <FlagIcon active={p.isSellable} icon={Store} label={t('admin.sellableFlag')} />
                            <FlagIcon active={p.isStockable} icon={Package} label={t('admin.stockFlag')} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {/* R13: 86 sold-out quick toggle */}
                          <button
                            type="button"
                            aria-pressed={p.soldOut === true}
                            aria-label={p.soldOut === true ? t('pos.markAvailable') : t('pos.markSoldOut')}
                            title={p.soldOut === true ? t('pos.markAvailable') : t('pos.markSoldOut')}
                            disabled={soldOutMutation.isPending}
                            onClick={() => soldOutMutation.mutate({ id: p.id, soldOut: !(p.soldOut === true) })}
                            className={cn(
                              'inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors',
                              p.soldOut === true
                                ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'border-[#E2E2E0] bg-white text-stone-500 hover:border-rose-300 hover:text-rose-600',
                            )}
                          >
                            {p.soldOut === true ? t('pos.86') : t('pos.markSoldOut')}
                          </button>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <ActiveBadge
                            active={p.active}
                            label={{ active: t('common.active'), inactive: t('common.inactive') }}
                          />
                        </TableCell>
                        <TableCell className="text-end">
                          <ProductRowActions
                            product={p}
                            onEdit={openEdit}
                            onDelete={setDeleteTarget}
                            labels={{
                              actionsFor: t('admin.actionsFor', { name: p.name }),
                              edit: t('common.edit'),
                              delete: t('common.delete'),
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Mobile card list */}
            <div className="space-y-2 md:hidden">
              {products.map((p) => (
                <div key={p.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {localizedName(p.name, p.nameAr, lang)}
                      </span>
                      {lang === 'ar' && !(p.nameAr ?? '').trim() && (
                        <MissingArBadge label={t('admin.missingAr')} />
                      )}
                      {!p.active && (
                        <ActiveBadge
                          active={false}
                          label={{ active: t('common.active'), inactive: t('common.inactive') }}
                        />
                      )}
                    </div>
                    {lang === 'ar' && p.name !== localizedName(p.name, p.nameAr, lang) ? (
                      <div className="truncate text-muted-foreground text-xs">{p.name}</div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                      {p.category ? (
                        <Badge variant="outline" className="px-1.5">{p.category.name}</Badge>
                      ) : (
                        <span>—</span>
                      )}
                      {p.isStockable && (
                        <span className={cn('tabular-nums', stockColorClass(p))}>
                          {t('admin.stockLabel', { qty: formatQty(p.stock) })}
                        </span>
                      )}
                      {p.soldOut === true && (
                        <Badge variant="outline" className="border-rose-300 bg-rose-50 px-1.5 text-rose-700">
                          {t('pos.86')}
                        </Badge>
                      )}
                      {p.sku ? <span className="font-mono">{p.sku}</span> : null}
                    </div>
                    <ProductTagBadges product={p} t={t} />
                  </div>
                  <div className="shrink-0 text-end">
                    <QuickPriceCell
                      product={p}
                      editValue={priceEdit?.id === p.id ? priceEdit.value : null}
                      saving={quickPriceMutation.isPending && quickPriceMutation.variables?.id === p.id}
                      t={t}
                      onStart={() => setPriceEdit({ id: p.id, value: String(p.price) })}
                      onChange={(v) => setPriceEdit({ id: p.id, value: v })}
                      onConfirm={() => confirmQuickPrice(p)}
                      onCancel={() => setPriceEdit(null)}
                    />
                  </div>
                  <ProductRowActions
                    product={p}
                    onEdit={openEdit}
                    onDelete={setDeleteTarget}
                    labels={{
                      actionsFor: t('admin.actionsFor', { name: p.name }),
                      edit: t('common.edit'),
                      delete: t('common.delete'),
                    }}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('admin.newProduct') : t('admin.editProduct')}</DialogTitle>
            <DialogDescription>
              {isCreate ? t('admin.productCreateDesc') : t('admin.productEditDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="product-name">
                  {t('common.name')} *
                </Label>
                <Input
                  id="product-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder={t('admin.productNamePlaceholder')}
                  className="h-11"
                  aria-invalid={errors.name ? true : undefined}
                />
                <FieldError message={errors.name} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="product-name-ar">{t('admin.nameArLabel')}</Label>
                <Input
                  id="product-name-ar"
                  lang="ar"
                  dir="rtl"
                  value={form.nameAr}
                  onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                  placeholder={t('admin.nameArPlaceholder')}
                  className="h-11"
                />
                <p className="text-muted-foreground text-xs">{t('admin.nameArHint')}</p>
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="product-category">{t('admin.category')}</Label>
              <Select
                value={form.categoryId === '' ? 'none' : form.categoryId}
                onValueChange={(v) => setForm({ ...form, categoryId: v === 'none' ? '' : v })}
              >
                <SelectTrigger id="product-category" className="h-11 w-full">
                  <SelectValue placeholder={t('admin.none')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('admin.none')}</SelectItem>
                  {categories.map((c) => (
                    <SelectItem
                      key={c.id}
                      value={String(c.id)}
                      className={c.active ? undefined : 'text-muted-foreground'}
                    >
                      {c.name}
                      {c.active ? '' : ` ${t('admin.inactiveSuffix')}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="product-price">
                  {t('common.price')} *
                </Label>
                <Input
                  id="product-price"
                  type="number"
                  step={0.01}
                  min={0}
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                  placeholder="0.00"
                  className="h-11"
                  aria-invalid={errors.price ? true : undefined}
                />
                <FieldError message={errors.price} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="product-cost">{t('common.cost')}</Label>
                <Input
                  id="product-cost"
                  type="number"
                  step={0.01}
                  min={0}
                  inputMode="decimal"
                  value={form.cost}
                  onChange={(e) => setForm({ ...form, cost: e.target.value })}
                  placeholder="0.00"
                  className="h-11"
                  aria-invalid={errors.cost ? true : undefined}
                />
                <FieldError message={errors.cost} />
              </div>
            </div>

            <SwitchRow
              id="product-sellable"
              label={t('admin.sellable')}
              helper={t('admin.sellableHint')}
              checked={form.isSellable}
              onCheckedChange={(checked) => setForm({ ...form, isSellable: checked })}
            />
            <SwitchRow
              id="product-stockable"
              label={t('admin.stockTracking')}
              helper={t('admin.stockTrackingHint')}
              checked={form.isStockable}
              onCheckedChange={(checked) => setForm({ ...form, isStockable: checked })}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="product-sku">{t('admin.sku')}</Label>
                <Input
                  id="product-sku"
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  placeholder={t('admin.skuPlaceholder')}
                  className="h-11"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="product-image">{t('admin.imageUrl')}</Label>
                <Input
                  id="product-image"
                  type="url"
                  value={form.imageUrl}
                  onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                  placeholder="https://…"
                  className="h-11"
                />
              </div>
            </div>

            {form.isStockable && (
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="product-threshold">{t('admin.lowStockAlertAt')}</Label>
                  <Input
                    id="product-threshold"
                    type="number"
                    step={0.01}
                    min={0}
                    inputMode="decimal"
                    value={form.lowStockThreshold}
                    onChange={(e) => setForm({ ...form, lowStockThreshold: e.target.value })}
                    className="h-11"
                    aria-invalid={errors.lowStockThreshold ? true : undefined}
                  />
                  <FieldError message={errors.lowStockThreshold} />
                </div>
                {isCreate && (
                  <div className="grid gap-2">
                    <Label htmlFor="product-initial-stock">{t('admin.initialStock')}</Label>
                    <Input
                      id="product-initial-stock"
                      type="number"
                      step={0.01}
                      min={0}
                      inputMode="decimal"
                      value={form.stock}
                      onChange={(e) => setForm({ ...form, stock: e.target.value })}
                      placeholder="0"
                      className="h-11"
                      aria-invalid={errors.stock ? true : undefined}
                    />
                    <p className="text-muted-foreground text-xs">{t('admin.initialStockHint')}</p>
                    <FieldError message={errors.stock} />
                  </div>
                )}
              </div>
            )}

            {/* R8: option groups offered with this product */}
            <div className="grid gap-2">
              <Label>{t('admin.attachGroups')}</Label>
              <p className="text-muted-foreground text-xs">{t('admin.attachGroupsHint')}</p>
              <div className="rms-scroll max-h-48 overflow-y-auto rounded-lg border p-1">
                {modifierGroupsQuery.isLoading ? (
                  <div className="space-y-1 p-1">
                    <Skeleton className="h-11 w-full" />
                    <Skeleton className="h-11 w-full" />
                  </div>
                ) : activeModifierGroups.length === 0 ? (
                  <p className="p-3 text-center text-muted-foreground text-sm">
                    {t('admin.noGroupsAvailable')}
                  </p>
                ) : (
                  activeModifierGroups.map((g) => (
                    <label
                      key={g.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md p-2.5 hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={form.modifierGroupIds.includes(g.id)}
                        onCheckedChange={(checked) => toggleModifierGroup(g.id, checked === true)}
                        aria-label={g.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {localizedName(g.name, g.nameAr, lang)}
                        </span>
                        <span className="block truncate text-muted-foreground text-xs">
                          {g.minSelect >= 1 ? t('admin.requiredGroup') : t('admin.optionalGroup')} ·{' '}
                          {g.maxSelect === 1
                            ? t('admin.pickOne')
                            : t('admin.pickUpTo', { n: g.maxSelect })}
                        </span>
                      </span>
                      <Badge variant="outline" className="shrink-0 text-muted-foreground">
                        {t('admin.attachedProducts', { n: g.productCount ?? 0 })}
                      </Badge>
                    </label>
                  ))
                )}
              </div>
            </div>

            {/* R8: allergens (warning chips) */}
            <div className="grid gap-2">
              <Label>{t('admin.allergens')}</Label>
              <p className="text-muted-foreground text-xs">{t('admin.tagsHint')}</p>
              <div className="flex flex-wrap gap-2">
                {ALLERGENS.map((a) => (
                  <TagChip
                    key={a}
                    label={t(`allergen.${a}`)}
                    selected={form.allergens.includes(a)}
                    tone="warning"
                    onToggle={() => toggleTag('allergens', a)}
                  />
                ))}
              </div>
            </div>

            {/* R8: dietary tags (green chips) */}
            <div className="grid gap-2">
              <Label>{t('admin.dietary')}</Label>
              <div className="flex flex-wrap gap-2">
                {DIETARY_TAGS.map((d) => (
                  <TagChip
                    key={d}
                    label={t(`dietary.${d}`)}
                    selected={form.dietary.includes(d)}
                    tone="success"
                    onToggle={() => toggleTag('dietary', d)}
                  />
                ))}
              </div>
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
              {saveMutation.isPending ? t('admin.saving') : isCreate ? t('admin.createProduct') : t('admin.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.deactivateProduct')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.deactivateProductDesc', { name: deleteTarget?.name ?? '' })}
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
