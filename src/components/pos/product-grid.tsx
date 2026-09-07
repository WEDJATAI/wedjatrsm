'use client'

import { useMemo, useState, type ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Coffee, IceCreamCone, Salad, Search, UtensilsCrossed } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCurrency } from '@/lib/format'
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
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('all')

  // Unique categories in first-seen order (API sorts by category displayOrder).
  const categories = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of products) {
      if (p.category && !map.has(p.category.id)) map.set(p.category.id, p.category.name)
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [products])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products.filter((p) => {
      if (activeCategory !== 'all' && (p.categoryId ?? -1) !== Number(activeCategory)) return false
      if (q && !p.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [products, search, activeCategory])

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {/* Search */}
      <div className="relative shrink-0 px-3 pb-3 pt-3 sm:px-4">
        <Search className="pointer-events-none absolute left-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground sm:left-7" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search dishes…"
          className="h-10 pl-9 text-base"
          inputMode="search"
        />
      </div>

      {/* Category tabs (scrollable) */}
      {categories.length > 0 && (
        <div className="shrink-0 px-3 pb-3 sm:px-4">
          <Tabs value={activeCategory} onValueChange={setActiveCategory}>
            <TabsList className="h-10 w-full max-w-full overflow-x-auto rms-scroll flex-nowrap p-[3px]">
              <TabsTrigger value="all" className="px-4 text-sm">
                All
              </TabsTrigger>
              {categories.map((c) => (
                <TabsTrigger key={c.id} value={String(c.id)} className="px-4 text-sm">
                  {c.name}
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
            <p className="text-sm">No sellable products available.</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Search className="size-8 opacity-40" />
            <p className="text-sm">No dishes match “{search}”.</p>
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
  const course = guessCourse(product)
  const Icon = COURSE_ICONS[course]
  const soldOut = product.isStockable && product.stock <= 0
  const lowStock = product.isStockable && product.stock > 0 && product.stock <= product.lowStockThreshold

  return (
    <Button
      type="button"
      variant="outline"
      disabled={soldOut}
      aria-disabled={soldOut}
      onClick={() => onAdd(product)}
      className={cn(
        'h-auto min-h-[84px] flex-col items-start justify-between gap-1 rounded-xl p-3 text-left active:scale-95 transition',
        'hover:border-primary hover:bg-primary/5',
        soldOut && 'pointer-events-none opacity-50 cursor-not-allowed',
      )}
      {...rest}
    >
      <span className="flex w-full items-start justify-between gap-1">
        <span className="line-clamp-2 text-sm leading-tight font-semibold">{product.name}</span>
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" aria-hidden />
      </span>
      <span className="flex w-full items-center justify-between gap-1">
        <span className="text-primary text-sm font-bold">{formatCurrency(product.price)}</span>
        {product.isStockable && (
          <span>
            {soldOut ? (
              <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700">
                Sold out
              </Badge>
            ) : lowStock ? (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">
                Low: {product.stock}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                {product.stock} left
              </Badge>
            )}
          </span>
        )}
      </span>
    </Button>
  )
}
