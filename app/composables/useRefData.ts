import type { ProductWithBrand, Row } from '#shared/types/models'

/** Reference data used across tabs: loaded once, refreshed after edits. */
export const useRefData = () => {
  const db = useDb()
  const people = useState<Row<'people'>[]>('ref-people', () => [])
  const channels = useState<Row<'channels'>[]>('ref-channels', () => [])
  /** hook types (the `angles` table keeps its old name) */
  const hookTypes = useState<Row<'angles'>[]>('ref-angles', () => [])
  const formats = useState<Row<'formats'>[]>('ref-formats', () => [])
  const products = useState<ProductWithBrand[]>('ref-products', () => [])
  /** every brand, archived ones too (brandOptions leaves those out) */
  const brands = useState<Pick<Row<'brands'>, 'id' | 'name' | 'archived_at'>[]>('ref-brands', () => [])
  const features = useState<Row<'product_features'>[]>('ref-features', () => [])
  const settings = useState<Row<'settings'> | null>('ref-settings', () => null)
  const loaded = useState('ref-loaded', () => false)

  async function load(force = false) {
    if (loaded.value && !force) return
    const [p, c, a, f, pr, s, fe, b] = await Promise.all([
      db.from('people').select('*').order('name'),
      db.from('channels').select('*').order('name'),
      db.from('angles').select('*').order('name'),
      db.from('formats').select('*').order('code'),
      db.from('products').select('*, brand:brands(*)').order('name'),
      db.from('settings').select('*').limit(1).maybeSingle(),
      db.from('product_features').select('*').order('sort_order').order('created_at'),
      db.from('brands').select('id, name, archived_at').order('name')
    ])
    people.value = must(p)
    channels.value = must(c)
    hookTypes.value = must(a)
    formats.value = must(f)
    products.value = must(pr) as ProductWithBrand[]
    settings.value = must(s)
    features.value = must(fe)
    brands.value = must(b)
    loaded.value = true
  }

  const hookTypeName = (id: string | null) => hookTypes.value.find(type => type.id === id)?.name ?? null

  const hookTypeOptions = computed(() =>
    hookTypes.value.filter(type => !type.archived).map(type => ({ label: type.name, value: type.id }))
  )
  /** products to pick from: an archived brand's products are left out (productOf still finds them) */
  const productOptions = computed(() =>
    products.value.filter(product => !product.brand.archived_at).map(product => ({ label: `${product.brand.name} — ${product.name}`, value: product.id }))
  )
  /** A product's core features, in order, as select options. */
  const featureOptions = (productId: string | null | undefined) =>
    features.value.filter(feature => feature.product_id === productId).map(feature => ({ label: feature.name, value: feature.id }))
  const featureOf = (id: string | null | undefined) => features.value.find(feature => feature.id === id) ?? null
  const productOf = (id: string | null | undefined) => products.value.find(product => product.id === id) ?? null

  /**
   * What a Library item is for, as one choice: every brand (general), one brand (any of its
   * products: `brand:<id>`), or one product (its id). Archived brands' are left out.
   */
  const scopeOptions = computed(() => [
    ...brands.value.filter(brand => !brand.archived_at).map(brand => ({ label: `${brand.name}: any product`, value: `brand:${brand.id}` })),
    ...productOptions.value
  ])
  const brandOf = (id: string | null | undefined) => brands.value.find(brand => brand.id === id) ?? null

  const channelOptions = computed(() =>
    channels.value.filter(channel => channel.active).map(channel => ({ label: channel.name, value: channel.id }))
  )

  return { people, channels, hookTypes, formats, products, brands, features, settings, load, hookTypeName, hookTypeOptions, productOptions, scopeOptions, featureOptions, featureOf, productOf, brandOf, channelOptions }
}
