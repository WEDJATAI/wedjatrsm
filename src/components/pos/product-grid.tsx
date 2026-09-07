'use client'

import { useMemo, useState, type ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Coffee, IceCreamCone, Salad, Search, UtensilsCrossed } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

type ProductGridProps = {
  products: Product[]
  onAdd: (product: Product) => void
  className?: string
}

export default function ProductGrid({ products, onAdd, className }: ProductGridProps) {
  const { t, lang } = useI18n()
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')

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
      if (activeCategory !== 'all' && (p.categoryId ?? -1) !== Number(activeCategory)) return false
      // Bilingual match: English (lowercased) + Arabic (case-less script, raw query).
      if (q && !p.name.toLowerCase().includes(q) && !(p.nameAr ?? '').includes(qRaw)) return false
      return true
    })
  }, [products, search, activeCategory])

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Search */}
      <div className="relative shrink-0 px-3 pb-3 pt-3 sm:px-4">
        <Search className="pointer-events-none absolute start-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:start-7" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('pos.searchDishes')}
          className="h-11 rounded-xl border-[#E2E2E0] bg-white ps-9 text-base"
          inputMode="search"
        />
      </div>

      {/* Category pills (scrollable) */}
      {categories.length > 0 && (
        <div className="shrink-0 px-3 pb-3 sm:px-4">
          <Tabs value={activeCategory} onValueChange={setActiveCategory}>
            <TabsList className="h-auto w-full max-w-full gap-1 overflow-x-auto rms-scroll flex-nowrap rounded-full border border-[#E2E2E0] bg-white p-1.5">
              <TabsTrigger
                value="all"
                className="h-11 rounded-full px-4 text-sm data-[state=active]:bg-[#714B67] data-[state=active]:text-white data-[state=active]:shadow-none"
              >
                {t('pos.all')}
              </TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger
                  key={c.id}
                  value={String(c.id)}
                  className="h-11 rounded-full px-4 text-sm data-[state=active]:bg-[#714B67] data-[state=active]:text-white data-[state=active]:shadow-none"
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
        {products.length === 0 ? (
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
              <ProductTile key={p.id} product={p} onAdd={onAdd} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProductTile({
  product,
  onAdd,
  ...rest
}: { product: Product; onAdd: (p: Product) => void } & Omit<ComponentProps<'button'>, 'onClick' | 'children'>) {
  const { t, lang } = useI18n()
  const course = guessCourse(product)
  const Icon = COURSE_ICONS[course]
  const soldOut = product.isStockable && product.stock <= 0
  const lowStock = product.isStockable && product.stock > 0 && product.stock <= product.lowStockThreshold
  const label = localizedName(product.name, product.nameAr, lang)
  // Arabic mode cross-reference: keep the English name visible as a tiny
  // secondary line (only when a distinct Arabic name exists).
  const showEnglishHint = lang === 'ar' && label !== product.name

  return (
    <Button
      type="button"
      variant="outline"
      disabled={soldOut}
      aria-disabled={soldOut}
      onClick={() => onAdd(product)}
      className={cn(
        'h-auto min-h-[96px] flex-col items-start justify-between gap-1.5 rounded-xl border-[#E2E2E0] bg-white p-3 text-start shadow-sm transition active:scale-95',
        'hover:border-[#714B67]/50 hover:bg-[#714B67]/[0.04] hover:shadow',
        soldOut && 'pointer-events-none cursor-not-allowed opacity-50',
      )}
      {...rest}
    >
      <span className="flex w-full items-start justify-between gap-1">
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
      <span className="flex w-full items-center justify-between gap-1">
        <span className="text-sm font-semibold tabular-nums text-[#714B67]">
          {formatCurrency(product.price)}
        </span>
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
    </Button>
  )
}
