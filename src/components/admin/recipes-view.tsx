'use client'

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BookOpen, Info, Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetch, fetcher } from '@/lib/api'
import type { Product, RecipeComponent } from '@/lib/types'
import { formatCurrency, formatQty } from '@/lib/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export default function RecipesView() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dishSearch, setDishSearch] = useState('')
  const [newIngredientId, setNewIngredientId] = useState('')
  const [newQuantity, setNewQuantity] = useState('1')

  const dishesQuery = useQuery({
    queryKey: ['products', 'sellable'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products?sellable=1'),
  })
  const stockableQuery = useQuery({
    queryKey: ['products', 'stockable'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products?stockable=1'),
  })

  const dishes = useMemo(() => dishesQuery.data?.products ?? [], [dishesQuery.data])
  const stockable = useMemo(
    () => stockableQuery.data?.products ?? [],
    [stockableQuery.data],
  )

  // First dish is preselected until the user picks one (derived, not stored).
  const activeDishId = selectedId ?? dishes[0]?.id ?? null
  const selectedDish = dishes.find((d) => d.id === activeDishId) ?? null

  const recipeQuery = useQuery({
    queryKey: ['recipes', activeDishId],
    queryFn: () =>
      fetcher<{ components: RecipeComponent[] }>(`/api/recipes?productId=${activeDishId}`),
    enabled: activeDishId != null,
  })
  const components = useMemo(
    () => recipeQuery.data?.components ?? [],
    [recipeQuery.data],
  )

  const recipeCost = components.reduce(
    (sum, c) => sum + (c.ingredient?.cost ?? 0) * c.quantity,
    0,
  )
  const price = selectedDish?.price ?? 0
  const hasComponents = components.length > 0

  const upsertMutation = useMutation({
    mutationFn: (vars: {
      productId: number
      ingredientId: number
      quantity: number
    }) =>
      apiFetch<{ component: RecipeComponent }>('/api/recipes', {
        method: 'POST',
        body: vars,
      }),
    onSuccess: (_data, vars) => {
      toast.success('Recipe saved')
      void queryClient.invalidateQueries({ queryKey: ['recipes', vars.productId] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean }>(`/api/recipes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Ingredient removed from recipe')
      if (activeDishId != null) {
        void queryClient.invalidateQueries({ queryKey: ['recipes', activeDishId] })
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const filteredDishes = useMemo(() => {
    const q = dishSearch.trim().toLowerCase()
    if (!q) return dishes
    return dishes.filter((d) => d.name.toLowerCase().includes(q))
  }, [dishes, dishSearch])

  const usedIngredientIds = useMemo(
    () => new Set(components.map((c) => c.ingredientId)),
    [components],
  )
  const availableIngredients = useMemo(
    () => stockable.filter((p) => !usedIngredientIds.has(p.id)),
    [stockable, usedIngredientIds],
  )

  function handleAddIngredient() {
    if (activeDishId == null) return
    if (!newIngredientId) {
      toast.error('Pick an ingredient first')
      return
    }
    const qty = Number(newQuantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error('Quantity must be greater than zero')
      return
    }
    upsertMutation.mutate(
      { productId: activeDishId, ingredientId: Number(newIngredientId), quantity: qty },
      {
        onSuccess: () => {
          setNewIngredientId('')
          setNewQuantity('1')
        },
      },
    )
  }

  // Margin badge: emerald < 60% food cost, amber < 80%, rose otherwise.
  let marginBadge: ReactNode = (
    <Badge className="border-transparent bg-zinc-100 text-zinc-600">—</Badge>
  )
  if (hasComponents) {
    if (price <= 0) {
      marginBadge = (
        <Badge className="border-transparent bg-rose-100 text-rose-700">
          No price set
        </Badge>
      )
    } else {
      const ratio = recipeCost / price
      const pct = Math.round(ratio * 100)
      const cls =
        ratio < 0.6
          ? 'border-transparent bg-emerald-100 text-emerald-700'
          : ratio < 0.8
            ? 'border-transparent bg-amber-100 text-amber-800'
            : 'border-transparent bg-rose-100 text-rose-700'
      marginBadge = <Badge className={cls}>Food cost {pct}%</Badge>
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Recipes</h1>
        <p className="text-sm text-muted-foreground">
          Bill of materials — ingredient costing per dish
        </p>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[300px_1fr]">
        {/* Dish picker */}
        <Card>
          <CardHeader>
            <CardTitle>Dishes</CardTitle>
            <CardDescription>
              {dishes.length} sellable {dishes.length === 1 ? 'dish' : 'dishes'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={dishSearch}
                onChange={(e) => setDishSearch(e.target.value)}
                placeholder="Search dishes…"
                className="pl-8"
              />
            </div>
            {dishesQuery.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 rounded-lg" />
                ))}
              </div>
            ) : dishesQuery.isError ? (
              <p className="py-6 text-center text-sm text-rose-600">
                {(dishesQuery.error as Error | null)?.message ??
                  'Failed to load dishes'}
              </p>
            ) : filteredDishes.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No dishes found.
              </p>
            ) : (
              <div className="max-h-[640px] space-y-1 overflow-y-auto rms-scroll pr-1">
                {filteredDishes.map((dish) => (
                  <button
                    key={dish.id}
                    type="button"
                    onClick={() => setSelectedId(dish.id)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg border p-2.5 text-left text-sm transition-colors',
                      dish.id === activeDishId
                        ? 'border-primary bg-primary/10'
                        : 'border-transparent hover:bg-muted',
                    )}
                  >
                    <span className="truncate font-medium">{dish.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatCurrency(dish.price)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recipe editor */}
        <Card>
          {selectedDish ? (
            <>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-3 text-xl font-bold">
                  <span>{selectedDish.name}</span>
                  <Badge variant="secondary" className="text-sm font-semibold">
                    {formatCurrency(price)}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Ingredient costing per serving vs sell price
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Cost summary */}
                <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Recipe cost</p>
                    <p className="text-lg font-bold">{formatCurrency(recipeCost)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Sell price</p>
                    <p className="text-lg font-semibold">{formatCurrency(price)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Food cost</p>
                    <div className="pt-1">{marginBadge}</div>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Margin / serving</p>
                    <p className="text-lg font-semibold text-emerald-700">
                      {hasComponents
                        ? formatCurrency(Math.max(0, price - recipeCost))
                        : '—'}
                    </p>
                  </div>
                </div>

                {/* Components */}
                {recipeQuery.isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <Skeleton key={i} className="h-12" />
                    ))}
                  </div>
                ) : recipeQuery.isError ? (
                  <p className="py-6 text-center text-sm text-rose-600">
                    {(recipeQuery.error as Error | null)?.message ??
                      'Failed to load recipe'}
                  </p>
                ) : components.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
                    <BookOpen className="size-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      No ingredients yet — add the first one below
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ingredient</TableHead>
                        <TableHead>Qty per unit</TableHead>
                        <TableHead className="text-right">
                          Cost per serving
                        </TableHead>
                        <TableHead className="w-12" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {components.map((component) => {
                        const ingredient = component.ingredient
                        const isLow = ingredient
                          ? ingredient.stock <= ingredient.lowStockThreshold
                          : false
                        return (
                          <TableRow key={component.id}>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">
                                  {ingredient?.name ?? `#${component.ingredientId}`}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    isLow
                                      ? 'border-rose-200 text-rose-600'
                                      : 'text-muted-foreground',
                                  )}
                                >
                                  stock {formatQty(ingredient?.stock ?? 0)}
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell>
                              <QtyInput
                                key={`${component.id}-${component.quantity}`}
                                component={component}
                                disabled={upsertMutation.isPending}
                                onSave={(ingredientId, quantity) => {
                                  if (activeDishId != null) {
                                    upsertMutation.mutate({
                                      productId: activeDishId,
                                      ingredientId,
                                      quantity,
                                    })
                                  }
                                }}
                              />
                            </TableCell>
                            <TableCell className="text-right font-medium">
                              {formatCurrency(
                                (ingredient?.cost ?? 0) * component.quantity,
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                    aria-label={`Remove ${
                                      ingredient?.name ?? 'ingredient'
                                    }`}
                                  >
                                    <Trash2 />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>
                                      Remove ingredient from recipe?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                      {ingredient?.name ?? 'This ingredient'} will no
                                      longer be deducted when {selectedDish.name} is
                                      sold.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-rose-600 text-white hover:bg-rose-700"
                                      onClick={() => deleteMutation.mutate(component.id)}
                                    >
                                      Remove
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}

                {/* Add ingredient */}
                <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3">
                  <div className="min-w-48 flex-1 space-y-1.5">
                    <Label className="text-xs text-muted-foreground">
                      Add ingredient
                    </Label>
                    {stockableQuery.isLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : availableIngredients.length === 0 ? (
                      <p className="pt-2 text-sm text-muted-foreground">
                        {stockable.length === 0
                          ? 'No stockable products available.'
                          : 'All stockable ingredients are already in this recipe.'}
                      </p>
                    ) : (
                      <Select
                        value={newIngredientId}
                        onValueChange={setNewIngredientId}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Pick an ingredient" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableIngredients.map((p) => (
                            <SelectItem key={p.id} value={String(p.id)}>
                              {p.name} · stock {formatQty(p.stock)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  {availableIngredients.length > 0 && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Qty per unit
                        </Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={newQuantity}
                          onChange={(e) => setNewQuantity(e.target.value)}
                          className="w-24 font-mono"
                        />
                      </div>
                      <Button
                        onClick={handleAddIngredient}
                        disabled={upsertMutation.isPending || !newIngredientId}
                      >
                        <Plus />
                        Add
                      </Button>
                    </>
                  )}
                </div>

                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Info className="size-3.5 shrink-0" />
                  Inventory is deducted automatically when an order is fully paid
                </p>
              </CardContent>
            </>
          ) : (
            <CardContent>
              {dishesQuery.isLoading ? (
                <Skeleton className="h-40 rounded-lg" />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                  <BookOpen className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    No dishes available — create sellable products first.
                  </p>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
}

/** Inline-editable quantity cell — commits on blur/Enter via upsert.
 *  Remounted (keyed on id+quantity) when the server value changes. */
function QtyInput({
  component,
  disabled,
  onSave,
}: {
  component: RecipeComponent
  disabled?: boolean
  onSave: (ingredientId: number, quantity: number) => void
}) {
  const [value, setValue] = useState(String(component.quantity))

  function commit() {
    const qty = Number(value)
    if (Number.isFinite(qty) && qty > 0 && qty !== component.quantity) {
      onSave(component.ingredientId, qty)
    } else {
      setValue(String(component.quantity))
    }
  }

  return (
    <Input
      type="number"
      step="0.01"
      min="0"
      inputMode="decimal"
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="h-8 w-24 font-mono"
      aria-label={`Quantity of ${
        component.ingredient?.name ?? 'ingredient'
      } per unit`}
    />
  )
}
