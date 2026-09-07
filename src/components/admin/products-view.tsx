'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  MoreHorizontal,
  Package,
  PackageSearch,
  Pencil,
  Plus,
  Search,
  Store,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency, formatQty } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import type { Category, Product } from '@/lib/types'
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
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {p.category ? (
                            <Badge variant="outline">{p.category.name}</Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums">
                          {formatCurrency(p.price)}
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
                      {p.sku ? <span className="font-mono">{p.sku}</span> : null}
                    </div>
                  </div>
                  <div className="shrink-0 text-end font-medium tabular-nums">
                    {formatCurrency(p.price)}
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
