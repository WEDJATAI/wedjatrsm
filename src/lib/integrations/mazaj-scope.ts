// R46: shared mazaj integration scope helpers.
//
// Both mazaj integration surfaces (the R45 inventory mirror + the R46
// catalog/status endpoints) gate on the SAME set of "shisha categories"
// (AppSetting mazajCategoryNames, default MAZAJ_DEFAULT_CATEGORY_NAMES).
// The helpers live here so the routes stay thin and the scope semantics
// can never drift between them.

import { db } from '@/lib/db'
import {
  MAZAJ_CATEGORY_NAMES_KEY,
  MAZAJ_DEFAULT_CATEGORY_NAMES,
} from '@/lib/constants'

/** Resolve the shisha category-name scope (setting overrides default). */
export async function shishaCategoryNames(): Promise<string[]> {
  const row = await db.appSetting.findUnique({ where: { key: MAZAJ_CATEGORY_NAMES_KEY } })
  const raw = row?.value?.trim() || MAZAJ_DEFAULT_CATEGORY_NAMES
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** The shisha-scope category ids (empty when the owner has no such category). */
export async function shishaCategoryIds(): Promise<number[]> {
  const names = await shishaCategoryNames()
  const cats = await db.category.findMany({ select: { id: true, name: true } })
  return cats.filter((c) => names.includes(c.name.trim().toLowerCase())).map((c) => c.id)
}

export type ScopedProduct = {
  id: number
  name: string
  nameAr: string | null
  sku: string | null
  price: number
  active: boolean
  categoryId: number | null
}

/** All products inside the shisha scope (the integration's gating surface). */
export async function shishaScopeProducts(): Promise<ScopedProduct[]> {
  const ids = await shishaCategoryIds()
  if (ids.length === 0) return []
  return db.product.findMany({
    where: { categoryId: { in: ids } },
    select: {
      id: true,
      name: true,
      nameAr: true,
      sku: true,
      price: true,
      active: true,
      categoryId: true,
    },
    orderBy: { id: 'asc' },
  })
}
