// What a Library item is for: every brand (general: nothing set), one brand and any of its products
// (brand_id set), or one product (product_id set). In an editor it's one choice: undefined, a
// product id, or `brand:<id>`.

export function scopeOf(row: { product_id?: string | null, brand_id?: string | null } | null | undefined): string | undefined {
  if (row?.product_id) return row.product_id
  if (row?.brand_id) return `brand:${row.brand_id}`
  return undefined
}

export function scopeFields(scope: string | null | undefined): { product_id: string | null, brand_id: string | null } {
  if (!scope) return { product_id: null, brand_id: null }
  if (scope.startsWith('brand:')) return { product_id: null, brand_id: scope.slice('brand:'.length) }
  return { product_id: scope, brand_id: null }
}

/**
 * The PostgREST `or` filter for the Library items a product's shoots can use: that product's own,
 * its brand's, and the general ones.
 */
export function libraryFilterFor(productId: string, brandId: string | null | undefined): string {
  return `product_id.eq.${productId},and(product_id.is.null,brand_id.is.null)${brandId ? `,and(product_id.is.null,brand_id.eq.${brandId})` : ''}`
}
