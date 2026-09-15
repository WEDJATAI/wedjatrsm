'use client'

import { useMemo, useState, useSyncExternalStore, type ComponentProps } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type LucideIcon, CircleCheck, CircleSlash, Coffee, IceCreamCone, Salad, Search, SlidersHorizontal, Star, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { Product } from '@/lib/types'
import { guessCourse, type CourseKey } from './pos-utils'

const COURSE_ICONS: Record<CourseKey, LucideIcon> = {
  starter: Salad,
  main: UtensilsCrossed,
  dessert: IceCreamCone,
  drink: Coffee,
}

/** localStorage key holding the waiter's favorite product ids (R8). */
const FAVORITES_KEY = 'rms-favorites'
const FAVORITES_EVENT = 'rms-favorites-change'
const EMPTY_FAVORITES: ReadonlySet<number> = new Set<number>()

/** Read the favorites list from localStorage (guarded — private mode etc.). */
function readFavorites(): Set<number> {
  try {
    const raw = window.localStorage.getItem(FAVORITES_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0),
    )
  } catch {
    return new Set()
  }
}

/** Persist the favorites list (guarded, fire-and-forget). */
function writeFavorites(ids: number[]): void {
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids))
  } catch {
    // storage unavailable — favorites last for the session only
  }
}

// ── favorites as an external store (SSR-safe, no mount effect) ────────
// The cached Set keeps getSnapshot referentially stable; mutations swap
// the cache and notify subscribers (same pattern as the i18n language).
let favoritesCache: Set<number> | null = null

function favoritesSnapshot(): ReadonlySet<number> {
  if (favoritesCache == null) favoritesCache = readFavorites()
  return favoritesCache
}

function favoritesServerSnapshot(): ReadonlySet<number> {
  return EMPTY_FAVORITES
}

function subscribeFavorites(onChange: () => void): () => void {
  const handler = () => {
    // drop the cache so the next snapshot re-reads localStorage (covers
    // changes made in another tab through the 'storage' event)
    favoritesCache = null
    onChange()
  }
  window.addEventListener(FAVORITES_EVENT, handler)
  window.addEventListener('storage', handler)
  return () => {
    window.removeEventListener(FAVORITES_EVENT, handler)
    window.removeEventListener('storage', handler)
  }
}

/** Toggle a product in the favorites list and notify the store. */
function toggleFavoriteId(current: ReadonlySet<number>, id: number): boolean {
  const next = new Set(current)
  const added = !next.has(id)
  if (added) next.add(id)
  else next.delete(id)
  writeFavorites(Array.from(next))
  favoritesCache = next
  window.dispatchEvent(new Event(FAVORITES_EVENT))
  return added
}

type ProductGridProps = {
  products: Product[]
  onAdd: (product: Product) => void
  className?: string
}

export default function ProductGrid({ products, onAdd, className }: ProductGridProps) {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')
  // R8: favorites filter (own pill row before the category pills).
  const [favOnly, setFavOnly] = useState(false)
  // Favorites live in localStorage behind an external store (SSR-safe read,
  // same-tab + cross-tab updates both re-render).
  const favorites = useSyncExternalStore(
    subscribeFavorites,
    favoritesSnapshot,
    favoritesServerSnapshot,
  )

  const toggleFavorite = (id: number) => {
    const added = toggleFavoriteId(favorites, id)
    toast.success(added ? t('pos.addedToFavorites') : t('pos.removedFromFavorites'))
  }

  // ── R13: "86" quick availability toggle ──────────────────────
  // One tap on the tile's ban chip flips the product's sold-out flag.
  // Optimistic update on both POS + admin product caches, undo toast
  // on success, rollback + error toast on failure.
  const soldOutMutation = useMutation({
    mutationFn: ({ id, soldOut }: { id: number; soldOut: boolean }) =>
      apiFetch<{ product: { id: number; soldOut: boolean } }>(`/api/products/${id}/sold-out`, {
        method: 'PATCH',
        body: { soldOut },
      }),
    onMutate: async ({ id, soldOut }) => {
      await queryClient.cancelQueries({ queryKey: ['pos-products'] })
      const prevPos = queryClient.getQueryData<{ products: Product[] }>(['pos-products'])
      if (prevPos) {
        queryClient.setQueryData(['pos-products'], {
          ...prevPos,
          products: prevPos.products.map((p) => (p.id === id ? { ...p, soldOut } : p)),
        })
      }
      // admin cache is keyed ['products', {...filters}] — patch every entry
      queryClient.setQueriesData<{ products: Product[] }>({ queryKey: ['products'] }, (old) =>
        old ? { products: old.products.map((p) => (p.id === id ? { ...p, soldOut } : p)) } : old,
      )
      return { prevPos }
    },
    onError: (err, _vars, ctx) => {
      toast.error(err instanceof Error ? err.message : t('common.error'))
      if (ctx?.prevPos) queryClient.setQueryData(['pos-products'], ctx.prevPos)
      // filtered admin caches: safest rollback is a refetch
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    },
    onSuccess: (_data, { id, soldOut }) => {
      const product = products.find((p) => p.id === id)
      const name = product ? localizedName(product.name, product.nameAr, lang) : ''
      toast.success(soldOut ? t('pos.soldOutToast', { name }) : t('pos.availableToast', { name }), {
        action: {
          label: t('pos.undo'),
          onClick: () => soldOutMutation.mutate({ id, soldOut: !soldOut }),
        },
      })
    },
  })

  const toggleSoldOut = (product: Product) => {
    if (soldOutMutation.isPending) return
    soldOutMutation.mutate({ id: product.id, soldOut: !product.soldOut })
  }

  // Unique categories in first-seen order (API sorts by category displayOrder).
  // Keeps the Arabic name alongside the English one for localized pills.
  const categories = useMemo(() => {
    const map = new Map<number, { name: string; nameAr: string | null }>()
    for (const p of products) {
      if (p.category && !map.has(p.category.id))
        map.set(p.category.id, { name: p.category.name, nameAr: p.category.nameAr ?? null })
    }
    return Array.from(map.entries()).map(([id, names]) => ({ id, ...names }))
  }, [products])

  const filtered = useMemo(() => {
    const qRaw = search.trim()
    const q = qRaw.toLowerCase()
    return products.filter((p) => {
      // Favorites mode replaces the category filter (search still applies).
      if (favOnly && !favorites.has(p.id)) return false
      if (!favOnly && activeCategory !== 'all' && (p.categoryId ?? -1) !== Number(activeCategory))
        return false
      // Bilingual match: English (lowercased) + Arabic (case-less script, raw query).
      if (q && !p.name.toLowerCase().includes(q) && !(p.nameAr ?? '').includes(qRaw)) return false
      return true
    })
  }, [products, search, activeCategory, favOnly, favorites])

  const hasAnyFavorite = favorites.size > 0

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Search */}
      <div className="relative shrink-0 px-3 pb-3 pt-3 sm:px-4">
        <Search className="pointer-events-none absolute start-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:start-7" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('pos.searchDishes')}
          className="h-11 rounded-xl border-border bg-white ps-9 text-base"
          inputMode="search"
        />
      </div>

      {/* R8: favorites pill — own row BEFORE the category pills (reachable on mobile) */}
      <div className="shrink-0 px-3 pb-2 sm:px-4">
        <Button
          type="button"
          variant="outline"
          aria-pressed={favOnly}
          onClick={() => setFavOnly((x) => !x)}
          className={cn(
            'h-11 rounded-full px-4 text-sm font-semibold transition-colors',
            favOnly
              ? 'border-primary bg-primary text-white hover:bg-primary/90 hover:text-white'
              : 'border-border bg-white text-stone-600 hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary',
          )}
        >
          <Star className={cn('size-4', favOnly && 'fill-amber-400 text-amber-400')} aria-hidden />
          {t('pos.favorites')}
        </Button>
      </div>

      {/* Category pills (scrollable) — picking a category leaves favorites mode */}
      {categories.length > 0 && (
        <div className="shrink-0 px-3 pb-3 sm:px-4">
          <Tabs
            value={activeCategory}
            onValueChange={(v) => {
              setActiveCategory(v)
              setFavOnly(false)
            }}
          >
            <TabsList className="h-auto w-full max-w-full gap-1 overflow-x-auto rms-scroll flex-nowrap rounded-full border border-border bg-white p-1.5">
              <TabsTrigger
                value="all"
                className="h-11 rounded-full px-4 text-sm data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-none"
              >
                {t('pos.all')}
              </TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger
                  key={c.id}
                  value={String(c.id)}
                  className="h-11 rounded-full px-4 text-sm data-[state=active]:bg-primary data-[state=active]:text-white data-[state=active]:shadow-none"
                >
                  {localizedName(c.name, c.nameAr, lang)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Product tiles */}
      <div className="rms-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4 sm:px-4">
        {favOnly && !hasAnyFavorite ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Star className="size-8 opacity-40" />
            <p className="text-sm">{t('pos.noFavorites')}</p>
          </div>
        ) : products.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <UtensilsCrossed className="size-8 opacity-40" />
            <p className="text-sm">{t('pos.noProducts')}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Search className="size-8 opacity-40" />
            <p className="text-sm">{t('pos.noMatch', { search: search.trim() })}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => (
              <ProductTile
                key={p.id}
                product={p}
                favorite={favorites.has(p.id)}
                onToggleFavorite={() => toggleFavorite(p.id)}
                onAdd={onAdd}
                onToggleSoldOut={() => toggleSoldOut(p)}
                soldOutPending={soldOutMutation.isPending && soldOutMutation.variables?.id === p.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProductTile({
  product,
  favorite,
  onToggleFavorite,
  onAdd,
  onToggleSoldOut,
  soldOutPending = false,
  ...rest
}: {
  product: Product
  favorite: boolean
  onToggleFavorite: () => void
  onAdd: (p: Product) => void
  onToggleSoldOut: () => void
  soldOutPending?: boolean
} & Omit<ComponentProps<'button'>, 'onClick' | 'children'>) {
  const { t, lang } = useI18n()
  const course = guessCourse(product)
  const Icon = COURSE_ICONS[course]
  // R13: manual 86 flag OR stock-tracked exhaustion both disable the tile
  const manualSoldOut = product.soldOut === true
  const soldOut = manualSoldOut || (product.isStockable && product.stock <= 0)
  const lowStock = product.isStockable && product.stock > 0 && product.stock <= product.lowStockThreshold
  const label = localizedName(product.name, product.nameAr, lang)
  // Arabic mode cross-reference: keep the English name visible as a tiny
  // secondary line (only when a distinct Arabic name exists).
  const showEnglishHint = lang === 'ar' && label !== product.name
  // R8: allergen/dietary tag chips (max 2 each + "+n", title = full list).
  const allergens = (product.allergens ?? []).slice()
  const dietary = (product.dietary ?? []).slice()
  const allergenTitle = allergens.map((a) => t(`allergen.${a}`)).join(', ')
  const dietaryTitle = dietary.map((d) => t(`dietary.${d}`)).join(', ')
  // R8: "has options" affordance — tapping opens the customize sheet.
  const hasOptions = (product.modifierGroups ?? []).some(
    (g) => g.active && g.modifiers.some((m) => m.active),
  )

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        disabled={soldOut}
        aria-disabled={soldOut}
        onClick={() => onAdd(product)}
        className={cn(
          'h-auto min-h-[96px] w-full flex-col items-start justify-between gap-1.5 rounded-xl border-border bg-white p-3 text-start shadow-sm transition active:scale-95',
          'hover:border-primary/50 hover:bg-primary/[0.04] hover:shadow',
          soldOut && 'pointer-events-none cursor-not-allowed opacity-50',
        )}
        {...rest}
      >
        <span className="flex w-full items-start justify-between gap-1 pe-9">
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-sm font-medium leading-tight">{label}</span>
            {showEnglishHint && (
              <span className="mt-0.5 block truncate text-[11px] leading-tight text-stone-400 line-clamp-1">
                {product.name}
              </span>
            )}
          </span>
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
        </span>

        {(allergens.length > 0 || dietary.length > 0) && (
          <span className="flex w-full flex-wrap items-center gap-1">
            {allergens.slice(0, 2).map((a) => (
              <span
                key={`al-${a}`}
                title={allergenTitle}
                className="rounded border border-rose-300 bg-rose-50 px-1 py-0 text-[10px] font-medium leading-4 text-rose-700"
              >
                {t(`allergen.${a}`)}
              </span>
            ))}
            {allergens.length > 2 && (
              <span
                title={allergenTitle}
                className="rounded border border-rose-300 bg-rose-50 px-1 py-0 text-[10px] font-medium leading-4 text-rose-700"
              >
                +{allergens.length - 2}
              </span>
            )}
            {dietary.slice(0, 2).map((d) => (
              <span
                key={`dt-${d}`}
                title={dietaryTitle}
                className="rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[10px] font-medium leading-4 text-emerald-700"
              >
                {t(`dietary.${d}`)}
              </span>
            ))}
            {dietary.length > 2 && (
              <span
                title={dietaryTitle}
                className="rounded border border-emerald-300 bg-emerald-50 px-1 py-0 text-[10px] font-medium leading-4 text-emerald-700"
              >
                +{dietary.length - 2}
              </span>
            )}
          </span>
        )}

        <span className="flex w-full items-center justify-between gap-1">
          <span className="text-sm font-semibold tabular-nums text-primary">
            {formatCurrency(product.price)}
          </span>
          <span className="flex min-w-0 items-center gap-1">
            {manualSoldOut && (
              <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">
                {t('pos.86')}
              </Badge>
            )}
            {hasOptions && (
              <Badge
                variant="outline"
                className="gap-1 border-primary/40 px-1.5 text-[10px] text-primary"
                title={t('pos.options')}
              >
                <SlidersHorizontal className="size-3" aria-hidden />
                {t('pos.options')}
              </Badge>
            )}
            {product.isStockable && (
              <span>
                {soldOut ? (
                  <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">
                    {t('pos.soldOut')}
                  </Badge>
                ) : lowStock ? (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                    {t('pos.lowStock', { qty: product.stock })}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">
                    {t('pos.left', { qty: product.stock })}
                  </Badge>
                )}
              </span>
            )}
          </span>
        </span>
      </Button>

      {/* R8: favorite star — sibling of the tile button (valid HTML), top-end
          corner. stopPropagation keeps the tap from adding the item. */}
      <button
        type="button"
        aria-pressed={favorite}
        aria-label={t('pos.favorites')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className={cn(
          'absolute end-0.5 top-0.5 z-10 grid size-11 place-items-center rounded-full transition-colors',
          favorite
            ? 'text-amber-500 hover:bg-amber-100'
            : 'text-stone-300 hover:bg-primary/10 hover:text-amber-400',
        )}
      >
        <Star className={cn('size-5', favorite && 'fill-amber-400 text-amber-500')} aria-hidden />
      </button>

      {/* R13: "86" availability toggle — top-START corner (star owns the
          end). One tap flips sold-out; the toast carries an Undo. Stock-
          exhausted (non-manual) tiles keep the chip disabled so waiters
          don't fight the inventory system. */}
      <button
        type="button"
        aria-pressed={manualSoldOut}
        aria-label={manualSoldOut ? t('pos.markAvailable') : t('pos.markSoldOut')}
        title={manualSoldOut ? t('pos.markAvailable') : t('pos.markSoldOut')}
        disabled={soldOutPending || (soldOut && !manualSoldOut)}
        onClick={(e) => {
          e.stopPropagation()
          onToggleSoldOut()
        }}
        className={cn(
          'absolute start-0.5 top-0.5 z-10 grid size-11 place-items-center rounded-full transition-colors',
          soldOutPending
            ? 'text-stone-400 opacity-60'
            : manualSoldOut
              ? 'text-rose-600 hover:bg-rose-100'
              : 'text-stone-300 hover:bg-rose-100 hover:text-rose-500',
          soldOut && !manualSoldOut && 'opacity-30 cursor-not-allowed',
        )}
      >
        {manualSoldOut ? (
          <CircleCheck className="size-5" aria-hidden />
        ) : (
          <CircleSlash className="size-5" aria-hidden />
        )}
      </button>
    </div>
  )
}
