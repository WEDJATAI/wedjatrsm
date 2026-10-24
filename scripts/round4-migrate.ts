// Round 4 migration — seed Arabic names for the existing menu
// (categories + products). ADDITIVE ONLY: sets nameAr where it is null,
// never touches English names, prices or stock. Run once.
import { db } from '../src/lib/db'

const CATEGORY_AR: Record<string, string> = {
  Starters: 'المقبلات',
  'Main Courses': 'الأطباق الرئيسية',
  Desserts: 'الحلويات',
  Beverages: 'المشروبات',
  'Ingredients (internal)': 'المكونات (داخلي)',
}

const PRODUCT_AR: Record<string, string> = {
  // Ingredients
  'Chicken Breast': 'صدور دجاج',
  'Beef Fillet': 'فيليه بقري',
  'Rice (kg)': 'أرز (كجم)',
  'Tomatoes (kg)': 'طماطم (كجم)',
  'Onions (kg)': 'بصل (كجم)',
  'Potatoes (kg)': 'بطاطس (كجم)',
  'Pasta (kg)': 'مكرونة (كجم)',
  'Cooking Cream (L)': 'كريمة الطبخ (لتر)',
  'Cheese (kg)': 'جبن (كجم)',
  'Eggs (dozen)': 'بيض (دستة)',
  'Chocolate (kg)': 'شوكولاتة (كجم)',
  'Flour (kg)': 'دقيق (كجم)',
  'Coffee Beans (kg)': 'حبوب قهوة (كجم)',
  'Milk (L)': 'لبن (لتر)',
  'Tilapia Fillet': 'فيليه بلطي',
  'Lemons (kg)': 'ليمون (كجم)',
  'Fresh Mint (bunch)': 'نعناع طازج (ضمة)',
  'Tea Leaves (kg)': 'أوراق شاي (كجم)',
  'Olive Oil (L)': 'زيت زيتون (لتر)',
  // Starters
  'Hummus with Olive Oil': 'حمص بزيت الزيتون',
  'Falafel Plate (6 pcs)': 'طبق فلافل (6 قطع)',
  'Cream of Tomato Soup': 'شوربة طماطم بالكريمة',
  'Caesar Salad': 'سلطة سيزر',
  'Garlic Bread': 'خبز بالثوم',
  // Mains
  'Koshari (Classic)': 'كشري (كلاسيك)',
  'Grilled Chicken Quarter': 'ربع دجاج مشوي',
  'Beef Tagine': 'طاجن بقري',
  'Pasta Alfredo with Chicken': 'مكرونة ألفريدو بالدجاج',
  'Grilled Tilapia Fillet': 'فيليه بلطي مشوي',
  'Margherita Pizza': 'بيتزا مارغريتا',
  // Desserts
  Basbousa: 'بسبوسة',
  'Chocolate Lava Cake': 'كيك الشوكولاتة باللب',
  'Rice Pudding (Mahalabia)': 'مهلبية',
  'Vanilla Ice Cream': 'آيس كريم فانيليا',
  // Beverages
  'Fresh Mint Tea': 'شاي بالنعناع',
  'Turkish Coffee': 'قهوة تركية',
  'Soft Drink (Can)': 'مشروب غازي (علبة)',
  'Mineral Water 600ml': 'مياه معدنية 600 مل',
  'Fresh Orange Juice': 'عصير برتقال طازج',
}

async function main() {
  let catSet = 0
  for (const [en, ar] of Object.entries(CATEGORY_AR)) {
    const result = await db.category.updateMany({
      where: { name: en, nameAr: null },
      data: { nameAr: ar },
    })
    catSet += result.count
  }
  let prodSet = 0
  for (const [en, ar] of Object.entries(PRODUCT_AR)) {
    const result = await db.product.updateMany({
      where: { name: en, nameAr: null },
      data: { nameAr: ar },
    })
    prodSet += result.count
  }
  const cats = await db.category.count({ where: { nameAr: { not: null } } })
  const prods = await db.product.count({ where: { nameAr: { not: null } } })
  console.log(`categories nameAr set: ${catSet} (total with nameAr: ${cats})`)
  console.log(`products nameAr set: ${prodSet} (total with nameAr: ${prods})`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => process.exit(0))
