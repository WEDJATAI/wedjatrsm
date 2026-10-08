/**
 * p21: THE RECIPE BOOK — Lelo Cafe & Restaurant (full menu).
 *
 * Owner directive: "Check current menu and based on your experience, give
 * full recipes till the chef edits them later."
 *
 * Written from restaurant-ops experience for an Egyptian café/restaurant of
 * this profile. Every quantity is PER SINGLE SERVING of the dish, expressed
 * in the INGREDIENT's base unit (embedded in its name: kg / L / dozen /
 * piece / loaf / head / bunch / pack).
 *
 *   example: Cheese (kg) 0.025  =  25 grams of cheese per serving — when the
 *   dish is sold & paid, 25 g leave stock automatically (deductInventoryForOrder).
 *
 * The chef edits these later from Admin → Recipes (quantities are upserts).
 * Soft drinks & water (211-218) are unit items — tracked as their own
 * stockable cans once the owner enables can inventory (recommended, see
 * runbook p21) — no recipe rows for them by design.
 */

// ─── Ingredient palette ────────────────────────────────────────────────
// [name, nameAr, parStock, lowThreshold, costEGP-per-unit]
// ids 1-19 already exist locally AND on Neon (aligned). New ones are created
// with explicit ids from 230 (Neon's product id space ends at 229 — NEVER
// let local autoincrement collide with it).

export type IngredientSeed = {
  name: string
  nameAr: string
  par: number
  low: number
  cost: number
}

/** NEW ingredients (created at explicit ids ≥ 230). */
export const NEW_INGREDIENTS: IngredientSeed[] = [
  { name: 'Sugar (kg)', nameAr: 'سكر (كجم)', par: 25, low: 8, cost: 32 },
  { name: 'Butter (kg)', nameAr: 'زبدة (كجم)', par: 12, low: 4, cost: 340 },
  { name: 'Mozzarella (kg)', nameAr: 'موزاريلا (كجم)', par: 30, low: 10, cost: 320 },
  { name: 'Cream Cheese (kg)', nameAr: 'جبنة كريمي (كجم)', par: 12, low: 4, cost: 300 },
  { name: 'Parmesan (kg)', nameAr: 'بارميزان (كجم)', par: 8, low: 3, cost: 420 },
  { name: 'Beef Bacon (kg)', nameAr: 'بيكون لحم (كجم)', par: 8, low: 3, cost: 380 },
  { name: 'Pastrami (kg)', nameAr: 'بسطرمة (كجم)', par: 10, low: 4, cost: 420 },
  { name: 'Pepperoni (kg)', nameAr: 'بيبروني (كجم)', par: 10, low: 4, cost: 400 },
  { name: 'Sausage (kg)', nameAr: 'سجق (كجم)', par: 15, low: 5, cost: 300 },
  { name: 'Beef Liver (kg)', nameAr: 'كبدة (كجم)', par: 15, low: 5, cost: 260 },
  { name: 'Kebab Meat (kg)', nameAr: 'لحم كباب (كجم)', par: 20, low: 7, cost: 380 },
  { name: 'Beef Mince (kg)', nameAr: 'لحم مفروم (كجم)', par: 20, low: 7, cost: 340 },
  { name: 'Shrimp (kg)', nameAr: 'جمبري (كجم)', par: 12, low: 4, cost: 320 },
  { name: 'Crab Sticks (kg)', nameAr: 'كابوريا (كجم)', par: 6, low: 2, cost: 180 },
  { name: 'Tuna (kg)', nameAr: 'تونة (كجم)', par: 12, low: 4, cost: 260 },
  { name: 'Toast Bread (loaf)', nameAr: 'عيش توست (رغيف)', par: 30, low: 10, cost: 30 },
  { name: 'Burger Bun (piece)', nameAr: 'عيش برجر (قطعة)', par: 100, low: 30, cost: 8 },
  { name: 'Tortilla (piece)', nameAr: 'تورتيلا (قطعة)', par: 100, low: 30, cost: 9 },
  { name: 'Vermicelli (kg)', nameAr: 'شعرية (كجم)', par: 8, low: 3, cost: 36 },
  { name: 'Orzo (kg)', nameAr: 'لسان العصفور (كجم)', par: 6, low: 2, cost: 44 },
  { name: 'Mushrooms (kg)', nameAr: 'مشروم (كجم)', par: 15, low: 5, cost: 120 },
  { name: 'Bell Peppers (kg)', nameAr: 'فلفل ألوان (كجم)', par: 15, low: 5, cost: 60 },
  { name: 'Jalapeno (kg)', nameAr: 'هالبينو (كجم)', par: 4, low: 1.5, cost: 140 },
  { name: 'Cucumber (kg)', nameAr: 'خيار (كجم)', par: 12, low: 4, cost: 30 },
  { name: 'Lettuce (head)', nameAr: 'خس (رأس)', par: 20, low: 7, cost: 20 },
  { name: 'Rocca (bunch)', nameAr: 'جرجير (حزمة)', par: 15, low: 5, cost: 10 },
  { name: 'Carrots (kg)', nameAr: 'جزر (كجم)', par: 10, low: 4, cost: 28 },
  { name: 'Peas (kg)', nameAr: 'بسلة (كجم)', par: 8, low: 3, cost: 60 },
  { name: 'Corn (kg)', nameAr: 'ذرة (كجم)', par: 10, low: 4, cost: 40 },
  { name: 'Garlic (kg)', nameAr: 'ثوم (كجم)', par: 4, low: 1.5, cost: 80 },
  { name: 'Ginger (kg)', nameAr: 'زنجبيل (كجم)', par: 3, low: 1, cost: 90 },
  { name: 'Honey (kg)', nameAr: 'عسل (كجم)', par: 6, low: 2, cost: 220 },
  { name: 'Cocoa Powder (kg)', nameAr: 'كاكاو (كجم)', par: 5, low: 2, cost: 180 },
  { name: 'Caramel Syrup (L)', nameAr: 'شراب كراميل (لتر)', par: 8, low: 3, cost: 90 },
  { name: 'Blue Curacao (L)', nameAr: 'بلو كوراساو (لتر)', par: 4, low: 1.5, cost: 160 },
  { name: 'Grenadine Syrup (L)', nameAr: 'شراب جراندين (لتر)', par: 6, low: 2, cost: 80 },
  { name: 'Soda Water (L)', nameAr: 'سودا (لتر)', par: 30, low: 10, cost: 18 },
  { name: 'Mango (kg)', nameAr: 'مانجو (كجم)', par: 25, low: 8, cost: 60 },
  { name: 'Strawberry (kg)', nameAr: 'فراولة (كجم)', par: 15, low: 5, cost: 90 },
  { name: 'Guava (kg)', nameAr: 'جوافة (كجم)', par: 15, low: 5, cost: 45 },
  { name: 'Oranges (kg)', nameAr: 'برتقال (كجم)', par: 30, low: 10, cost: 30 },
  { name: 'Kiwi (kg)', nameAr: 'كيوي (كجم)', par: 10, low: 4, cost: 100 },
  { name: 'Watermelon (kg)', nameAr: 'بطيخ (كجم)', par: 30, low: 10, cost: 15 },
  { name: 'Banana (kg)', nameAr: 'موز (كجم)', par: 20, low: 7, cost: 40 },
  { name: 'Passion Fruit (kg)', nameAr: 'باشون فروت (كجم)', par: 6, low: 2, cost: 140 },
  { name: 'Peach (kg)', nameAr: 'خوخ (كجم)', par: 10, low: 4, cost: 70 },
  { name: 'Blueberry (kg)', nameAr: 'بلوبيري (كجم)', par: 8, low: 3, cost: 180 },
  { name: 'Apple (kg)', nameAr: 'تفاح (كجم)', par: 12, low: 4, cost: 60 },
  { name: 'Yogurt (L)', nameAr: 'زبادي (لتر)', par: 25, low: 8, cost: 40 },
  { name: 'Ice Cream (L)', nameAr: 'آيس كريم (لتر)', par: 25, low: 8, cost: 120 },
  { name: 'Whipped Cream (L)', nameAr: 'كريمة مخفوقة (لتر)', par: 15, low: 5, cost: 140 },
  { name: 'Lotus Spread (kg)', nameAr: 'لوتس (كجم)', par: 8, low: 3, cost: 300 },
  { name: 'Oreo (pack)', nameAr: 'أوريو (عبوة)', par: 30, low: 10, cost: 25 },
  { name: 'Kit Kat (pack)', nameAr: 'كيت كات (عبوة)', par: 25, low: 8, cost: 30 },
  { name: 'Maltesers (pack)', nameAr: 'مالتيزرز (عبوة)', par: 20, low: 7, cost: 35 },
  { name: 'Marshmallow (pack)', nameAr: 'مارشميلو (عبوة)', par: 15, low: 5, cost: 30 },
  { name: 'Nutella (kg)', nameAr: 'نوتيلا (كجم)', par: 8, low: 3, cost: 380 },
  { name: 'Cornstarch (kg)', nameAr: 'نشا (كجم)', par: 4, low: 1.5, cost: 30 },
  { name: 'Nuts (kg)', nameAr: 'مكسرات (كجم)', par: 6, low: 2, cost: 400 },
  { name: 'Digestive Biscuits (pack)', nameAr: 'بسكويت دايجستف (عبوة)', par: 15, low: 5, cost: 35 },
  { name: 'Vegetable Oil (L)', nameAr: 'زيت طعام (لتر)', par: 40, low: 15, cost: 70 },
  { name: 'Mayonnaise (kg)', nameAr: 'مايونيز (كجم)', par: 10, low: 4, cost: 80 },
  { name: 'Ketchup (kg)', nameAr: 'كاتشب (كجم)', par: 12, low: 4, cost: 55 },
  { name: 'Ranch Sauce (L)', nameAr: 'صوص رانش (لتر)', par: 10, low: 4, cost: 110 },
  { name: 'BBQ Sauce (L)', nameAr: 'صوص باربكيو (لتر)', par: 8, low: 3, cost: 100 },
  { name: 'Cocktail Sauce (kg)', nameAr: 'صوص كوكتيل (كجم)', par: 6, low: 2, cost: 90 },
  { name: 'Cheese Sauce (kg)', nameAr: 'صوص جبنة (كجم)', par: 20, low: 7, cost: 130 },
  { name: 'Hot Sauce (kg)', nameAr: 'صوص حار (كجم)', par: 5, low: 2, cost: 70 },
  { name: 'Soy Sauce (L)', nameAr: 'صويا صوص (لتر)', par: 4, low: 1.5, cost: 90 },
  { name: 'Doritos (pack)', nameAr: 'دوريتوس (عبوة)', par: 40, low: 15, cost: 20 },
  { name: 'Mustard (kg)', nameAr: 'مستردة (كجم)', par: 4, low: 1.5, cost: 75 },
  { name: 'Tahini (kg)', nameAr: 'طحينة (كجم)', par: 4, low: 1.5, cost: 90 },
  { name: 'Vinegar (L)', nameAr: 'خل (لتر)', par: 6, low: 2, cost: 30 },
  { name: 'Mixed Spices (kg)', nameAr: 'بهارات (كجم)', par: 3, low: 1, cost: 150 },
]

/** PAR stock + low-stock thresholds for the 19 EXISTING ingredients (ids 1-19). */
export const EXISTING_PARS: Record<string, { par: number; low: number }> = {
  'Chicken Breast': { par: 40, low: 12 },
  'Beef Fillet': { par: 30, low: 10 },
  'Rice (kg)': { par: 50, low: 15 },
  'Tomatoes (kg)': { par: 40, low: 12 },
  'Onions (kg)': { par: 40, low: 12 },
  'Potatoes (kg)': { par: 60, low: 20 },
  'Pasta (kg)': { par: 40, low: 12 },
  'Cooking Cream (L)': { par: 25, low: 8 },
  'Cheese (kg)': { par: 25, low: 8 },
  'Eggs (dozen)': { par: 30, low: 10 },
  'Chocolate (kg)': { par: 15, low: 5 },
  'Flour (kg)': { par: 60, low: 20 },
  'Coffee Beans (kg)': { par: 12, low: 4 },
  'Milk (L)': { par: 50, low: 15 },
  'Tilapia Fillet': { par: 20, low: 6 },
  'Lemons (kg)': { par: 20, low: 6 },
  'Fresh Mint (bunch)': { par: 15, low: 5 },
  'Tea Leaves (kg)': { par: 4, low: 1.5 },
  'Olive Oil (L)': { par: 15, low: 5 },
}

// ─── The recipe book ───────────────────────────────────────────────────
// dishId (LOCAL id space) → [ingredientName, qty-per-serving][]
// Dish ids 50/51/52/53 are remapped to Neon 226/227/228/229 in EVENT
// payloads only (see scripts/p21-seed-recipes.ts + p14 worklog).

export const RECIPES: Record<number, Array<[string, number]>> = {
  // ── Desserts ──
  138: [['Chocolate (kg)', 0.06], ['Butter (kg)', 0.03], ['Sugar (kg)', 0.05], ['Eggs (dozen)', 0.25], ['Flour (kg)', 0.04]],
  139: [['Flour (kg)', 0.08], ['Butter (kg)', 0.04], ['Cream Cheese (kg)', 0.05], ['Sugar (kg)', 0.03], ['Honey (kg)', 0.02]],
  140: [['Cream Cheese (kg)', 0.09], ['Sugar (kg)', 0.03], ['Eggs (dozen)', 0.17], ['Digestive Biscuits (pack)', 0.08], ['Butter (kg)', 0.02]],
  141: [['Ice Cream (L)', 0.15], ['Chocolate (kg)', 0.05], ['Butter (kg)', 0.02], ['Eggs (dozen)', 0.08], ['Flour (kg)', 0.02]],
  142: [['Flour (kg)', 0.05], ['Eggs (dozen)', 0.08], ['Milk (L)', 0.05], ['Chicken Breast', 0.08], ['Cooking Cream (L)', 0.04], ['Mushrooms (kg)', 0.04], ['Cheese (kg)', 0.03]],
  143: [['Oreo (pack)', 0.3], ['Ice Cream (L)', 0.12], ['Whipped Cream (L)', 0.03], ['Chocolate (kg)', 0.02], ['Milk (L)', 0.04]],
  144: [['Cream Cheese (kg)', 0.07], ['Mozzarella (kg)', 0.05], ['Whipped Cream (L)', 0.03], ['Sugar (kg)', 0.02], ['Digestive Biscuits (pack)', 0.05]],
  145: [['Ice Cream (L)', 0.12], ['Whipped Cream (L)', 0.02]],
  146: [['Milk (L)', 0.15], ['Sugar (kg)', 0.03], ['Nuts (kg)', 0.02], ['Whipped Cream (L)', 0.04], ['Cornstarch (kg)', 0.005]],
  147: [['Mango (kg)', 0.05], ['Strawberry (kg)', 0.05], ['Banana (kg)', 0.05], ['Apple (kg)', 0.04], ['Peach (kg)', 0.04], ['Whipped Cream (L)', 0.02]],

  // ── Breakfast ──
  50: [['Eggs (dozen)', 0.25], ['Tomatoes (kg)', 0.1], ['Onions (kg)', 0.05], ['Olive Oil (L)', 0.01], ['Flour (kg)', 0.03], ['Potatoes (kg)', 0.08], ['Rocca (bunch)', 0.05]],
  54: [['Eggs (dozen)', 0.33], ['Butter (kg)', 0.01], ['Cheese (kg)', 0.03], ['Tomatoes (kg)', 0.03], ['Onions (kg)', 0.02]],
  61: [['Flour (kg)', 0.06], ['Butter (kg)', 0.02], ['Eggs (dozen)', 0.08], ['Cheese (kg)', 0.04], ['Pastrami (kg)', 0.03]],

  // ── Appetizers & Sides ──
  62: [['Chicken Breast', 0.12], ['Flour (kg)', 0.03], ['Eggs (dozen)', 0.04], ['Vegetable Oil (L)', 0.03], ['Cocktail Sauce (kg)', 0.02]],
  63: [['Flour (kg)', 0.05], ['Chicken Breast', 0.06], ['Cream Cheese (kg)', 0.03], ['Bell Peppers (kg)', 0.02], ['Cheese Sauce (kg)', 0.02]],
  64: [['Mozzarella (kg)', 0.08], ['Flour (kg)', 0.03], ['Eggs (dozen)', 0.04], ['Toast Bread (loaf)', 0.05], ['Vegetable Oil (L)', 0.03], ['Cocktail Sauce (kg)', 0.02]],
  65: [['Mushrooms (kg)', 0.05], ['Chicken Breast', 0.08], ['Onions (kg)', 0.04], ['Mozzarella (kg)', 0.06], ['Flour (kg)', 0.06], ['Vegetable Oil (L)', 0.05], ['Cocktail Sauce (kg)', 0.03]],
  66: [['Potatoes (kg)', 0.25], ['Beef Mince (kg)', 0.08], ['Tomatoes (kg)', 0.06], ['Onions (kg)', 0.03], ['Cheese Sauce (kg)', 0.04]],
  67: [['Potatoes (kg)', 0.25], ['Jalapeno (kg)', 0.02], ['Pastrami (kg)', 0.05], ['Cheese Sauce (kg)', 0.05]],
  68: [['Potatoes (kg)', 0.25], ['Chicken Breast', 0.08], ['Cheese Sauce (kg)', 0.05], ['Flour (kg)', 0.02]],
  69: [['Potatoes (kg)', 0.25], ['Sausage (kg)', 0.07], ['Cheese Sauce (kg)', 0.04], ['Onions (kg)', 0.02]],
  70: [['Potatoes (kg)', 0.25], ['Pepperoni (kg)', 0.05], ['Mozzarella (kg)', 0.07], ['Cheese Sauce (kg)', 0.04]],
  71: [['Potatoes (kg)', 0.25], ['Cheese (kg)', 0.025], ['Cheese Sauce (kg)', 0.04]],

  // ── Soups ──
  72: [['Mushrooms (kg)', 0.12], ['Beef Bacon (kg)', 0.04], ['Cooking Cream (L)', 0.06], ['Butter (kg)', 0.015], ['Flour (kg)', 0.01]],
  73: [['Carrots (kg)', 0.04], ['Peas (kg)', 0.03], ['Corn (kg)', 0.03], ['Potatoes (kg)', 0.04], ['Onions (kg)', 0.03], ['Butter (kg)', 0.01]],
  74: [['Orzo (kg)', 0.05], ['Chicken Breast', 0.05], ['Carrots (kg)', 0.02], ['Onions (kg)', 0.02], ['Butter (kg)', 0.01]],
  75: [['Shrimp (kg)', 0.06], ['Tilapia Fillet', 0.06], ['Crab Sticks (kg)', 0.03], ['Tomatoes (kg)', 0.05], ['Onions (kg)', 0.03], ['Cooking Cream (L)', 0.04]],
  76: [['Chicken Breast', 0.08], ['Cooking Cream (L)', 0.06], ['Butter (kg)', 0.015], ['Flour (kg)', 0.015], ['Carrots (kg)', 0.02]],

  // ── Salads ──
  77: [['Lettuce (head)', 0.15], ['Rocca (bunch)', 0.08], ['Tomatoes (kg)', 0.05], ['Cucumber (kg)', 0.04], ['Parmesan (kg)', 0.02], ['Ranch Sauce (L)', 0.03], ['Chicken Breast', 0.08]],
  78: [['Chicken Breast', 0.12], ['Lettuce (head)', 0.15], ['Cheese (kg)', 0.03], ['Ranch Sauce (L)', 0.04], ['Toast Bread (loaf)', 0.05], ['Eggs (dozen)', 0.08]],
  79: [['Tomatoes (kg)', 0.08], ['Cucumber (kg)', 0.06], ['Onions (kg)', 0.04], ['Cheese (kg)', 0.05], ['Olive Oil (L)', 0.015], ['Rocca (bunch)', 0.04]],
  80: [['Chicken Breast', 0.12], ['Lettuce (head)', 0.15], ['Corn (kg)', 0.03], ['Cucumber (kg)', 0.04], ['Ranch Sauce (L)', 0.05]],
  81: [['Chicken Breast', 0.12], ['Lettuce (head)', 0.12], ['Bell Peppers (kg)', 0.04], ['Peach (kg)', 0.03], ['Ketchup (kg)', 0.02], ['Vinegar (L)', 0.005], ['Sugar (kg)', 0.01]],
  82: [['Tuna (kg)', 0.08], ['Lettuce (head)', 0.12], ['Tomatoes (kg)', 0.05], ['Cucumber (kg)', 0.04], ['Corn (kg)', 0.03], ['Olive Oil (L)', 0.01]],
  83: [['Tomatoes (kg)', 0.08], ['Cucumber (kg)', 0.06], ['Onions (kg)', 0.04], ['Rocca (bunch)', 0.05], ['Olive Oil (L)', 0.01], ['Lemons (kg)', 0.03]],

  // ── Lilo Pan Dishes ──
  84: [['Beef Liver (kg)', 0.15], ['Onions (kg)', 0.06], ['Bell Peppers (kg)', 0.04], ['Tomatoes (kg)', 0.04], ['Olive Oil (L)', 0.02], ['Mixed Spices (kg)', 0.003], ['Lemons (kg)', 0.03]],
  85: [['Sausage (kg)', 0.15], ['Onions (kg)', 0.06], ['Bell Peppers (kg)', 0.04], ['Tomatoes (kg)', 0.04], ['Olive Oil (L)', 0.02], ['Mixed Spices (kg)', 0.003]],
  86: [['Kebab Meat (kg)', 0.18], ['Onions (kg)', 0.08], ['Tomatoes (kg)', 0.05], ['Butter (kg)', 0.02], ['Mixed Spices (kg)', 0.004]],
  87: [['Beef Liver (kg)', 0.15], ['Onions (kg)', 0.05], ['Ketchup (kg)', 0.03], ['Mixed Spices (kg)', 0.003], ['Olive Oil (L)', 0.015]],
  88: [['Sausage (kg)', 0.13], ['Mozzarella (kg)', 0.06], ['Onions (kg)', 0.04], ['Bell Peppers (kg)', 0.03], ['Cheese Sauce (kg)', 0.03]],
  89: [['Chicken Breast', 0.13], ['Mozzarella (kg)', 0.06], ['Flour (kg)', 0.03], ['Eggs (dozen)', 0.04], ['Cheese Sauce (kg)', 0.04]],

  // ── Sandwiches ──
  51: [['Toast Bread (loaf)', 0.15], ['Chicken Breast', 0.1], ['Lettuce (head)', 0.06], ['Tomatoes (kg)', 0.04], ['Mayonnaise (kg)', 0.03], ['Cheese (kg)', 0.03]],
  52: [['Toast Bread (loaf)', 0.15], ['Pastrami (kg)', 0.05], ['Beef Bacon (kg)', 0.04], ['Cheese (kg)', 0.04], ['Butter (kg)', 0.01], ['Lettuce (head)', 0.04]],
  53: [['Toast Bread (loaf)', 0.25], ['Chicken Breast', 0.1], ['Beef Bacon (kg)', 0.04], ['Eggs (dozen)', 0.08], ['Lettuce (head)', 0.05], ['Tomatoes (kg)', 0.04], ['Mayonnaise (kg)', 0.03]],
  90: [['Burger Bun (piece)', 1], ['Beef Mince (kg)', 0.15], ['Cheese (kg)', 0.03], ['Tomatoes (kg)', 0.03], ['Lettuce (head)', 0.04], ['Ketchup (kg)', 0.02], ['Mayonnaise (kg)', 0.02]],
  91: [['Burger Bun (piece)', 1], ['Beef Mince (kg)', 0.15], ['Doritos (pack)', 0.15], ['BBQ Sauce (L)', 0.04], ['Cheese (kg)', 0.03], ['Lettuce (head)', 0.04]],
  92: [['Toast Bread (loaf)', 0.15], ['Beef Fillet', 0.12], ['Onions (kg)', 0.04], ['Bell Peppers (kg)', 0.03], ['Ranch Sauce (L)', 0.03]],
  93: [['Beef Liver (kg)', 0.13], ['Toast Bread (loaf)', 0.12], ['Onions (kg)', 0.05], ['Tahini (kg)', 0.02], ['Mixed Spices (kg)', 0.003], ['Lemons (kg)', 0.02]],
  94: [['Sausage (kg)', 0.13], ['Toast Bread (loaf)', 0.12], ['Onions (kg)', 0.05], ['Tahini (kg)', 0.02], ['Mixed Spices (kg)', 0.003]],
  95: [['Flour (kg)', 0.08], ['Beef Mince (kg)', 0.12], ['Onions (kg)', 0.04], ['Cheese (kg)', 0.04], ['Mixed Spices (kg)', 0.004]],
  96: [['Toast Bread (loaf)', 0.12], ['Chicken Breast', 0.1], ['Flour (kg)', 0.025], ['Eggs (dozen)', 0.04], ['Mayonnaise (kg)', 0.03], ['Lettuce (head)', 0.05]],
  97: [['Tortilla (piece)', 2], ['Chicken Breast', 0.11], ['Mozzarella (kg)', 0.07], ['Bell Peppers (kg)', 0.03], ['Ranch Sauce (L)', 0.03]],
  98: [['Toast Bread (loaf)', 0.15], ['Chicken Breast', 0.11], ['Cheese (kg)', 0.04], ['Ranch Sauce (L)', 0.03], ['Lettuce (head)', 0.05], ['Tomatoes (kg)', 0.03]],
  99: [['Toast Bread (loaf)', 0.15], ['Chicken Breast', 0.1], ['Cream Cheese (kg)', 0.03], ['Lettuce (head)', 0.05], ['Ranch Sauce (L)', 0.02]],
  100: [['Toast Bread (loaf)', 0.15], ['Shrimp (kg)', 0.1], ['Lettuce (head)', 0.05], ['Ranch Sauce (L)', 0.05], ['Cucumber (kg)', 0.03]],

  // ── Pasta ──
  101: [['Pasta (kg)', 0.14], ['Tomatoes (kg)', 0.08], ['Garlic (kg)', 0.005], ['Olive Oil (L)', 0.015], ['Mixed Spices (kg)', 0.002]],
  102: [['Pasta (kg)', 0.14], ['Chicken Breast', 0.1], ['Doritos (pack)', 0.15], ['Ranch Sauce (L)', 0.05], ['Cheese Sauce (kg)', 0.04]],
  103: [['Pasta (kg)', 0.14], ['Chicken Breast', 0.11], ['Bell Peppers (kg)', 0.05], ['Corn (kg)', 0.03], ['Ketchup (kg)', 0.02], ['Mixed Spices (kg)', 0.004]],
  104: [['Pasta (kg)', 0.14], ['Chicken Breast', 0.13], ['Flour (kg)', 0.03], ['Eggs (dozen)', 0.04], ['Cheese Sauce (kg)', 0.05]],
  105: [['Pasta (kg)', 0.14], ['Chicken Breast', 0.11], ['Cooking Cream (L)', 0.06], ['Cheese (kg)', 0.05], ['Mushrooms (kg)', 0.03]],
  106: [['Pasta (kg)', 0.14], ['Shrimp (kg)', 0.08], ['Tilapia Fillet', 0.07], ['Crab Sticks (kg)', 0.04], ['Cooking Cream (L)', 0.06], ['Cheese (kg)', 0.05]],
  107: [['Pasta (kg)', 0.14], ['Kebab Meat (kg)', 0.13], ['Onions (kg)', 0.05], ['Tomatoes (kg)', 0.05], ['Bell Peppers (kg)', 0.03]],
  108: [['Pasta (kg)', 0.14], ['Beef Fillet', 0.13], ['Mushrooms (kg)', 0.05], ['Cooking Cream (L)', 0.05], ['Cheese (kg)', 0.03]],
  109: [['Pasta (kg)', 0.14], ['Chicken Breast', 0.12], ['Cooking Cream (L)', 0.08], ['Butter (kg)', 0.02], ['Parmesan (kg)', 0.03]],
  110: [['Pasta (kg)', 0.14], ['Shrimp (kg)', 0.07], ['Tilapia Fillet', 0.07], ['Crab Sticks (kg)', 0.04], ['Tomatoes (kg)', 0.06], ['Garlic (kg)', 0.005], ['Cooking Cream (L)', 0.04]],
  111: [['Pasta (kg)', 0.14], ['Beef Liver (kg)', 0.13], ['Onions (kg)', 0.06], ['Bell Peppers (kg)', 0.04], ['Mixed Spices (kg)', 0.003]],
  112: [['Pasta (kg)', 0.14], ['Sausage (kg)', 0.13], ['Onions (kg)', 0.06], ['Bell Peppers (kg)', 0.04], ['Mixed Spices (kg)', 0.003]],
  113: [['Pasta (kg)', 0.14], ['Sausage (kg)', 0.12], ['Mozzarella (kg)', 0.08], ['Cheese Sauce (kg)', 0.05], ['Onions (kg)', 0.03]],

  // ── Main Dishes ──
  114: [['Vermicelli (kg)', 0.12], ['Beef Liver (kg)', 0.14], ['Onions (kg)', 0.06], ['Mixed Spices (kg)', 0.003], ['Olive Oil (L)', 0.02]],
  115: [['Vermicelli (kg)', 0.12], ['Sausage (kg)', 0.14], ['Onions (kg)', 0.06], ['Mixed Spices (kg)', 0.003], ['Olive Oil (L)', 0.02]],
  116: [['Vermicelli (kg)', 0.12], ['Kebab Meat (kg)', 0.15], ['Onions (kg)', 0.06], ['Tomatoes (kg)', 0.04], ['Butter (kg)', 0.015]],
  117: [['Beef Fillet', 0.25], ['Butter (kg)', 0.02], ['Potatoes (kg)', 0.15], ['Mixed Spices (kg)', 0.004], ['Mushrooms (kg)', 0.05]],
  118: [['Beef Fillet', 0.2], ['Mushrooms (kg)', 0.08], ['Cooking Cream (L)', 0.08], ['Onions (kg)', 0.04], ['Butter (kg)', 0.02]],
  119: [['Beef Fillet', 0.2], ['Bell Peppers (kg)', 0.08], ['Onions (kg)', 0.07], ['Tortilla (piece)', 2], ['Mixed Spices (kg)', 0.005]],
  120: [['Kebab Meat (kg)', 0.1], ['Beef Fillet', 0.1], ['Chicken Breast', 0.1], ['Onions (kg)', 0.06], ['Tomatoes (kg)', 0.05], ['Mixed Spices (kg)', 0.005]],
  121: [['Chicken Breast', 0.2], ['Mushrooms (kg)', 0.08], ['Cooking Cream (L)', 0.06], ['Butter (kg)', 0.02], ['Flour (kg)', 0.015]],
  122: [['Beef Fillet', 0.22], ['Butter (kg)', 0.02], ['Potatoes (kg)', 0.12], ['Mixed Spices (kg)', 0.003]],
  123: [['Chicken Breast', 0.25], ['Mixed Spices (kg)', 0.005], ['Olive Oil (L)', 0.01], ['Lemons (kg)', 0.03], ['Potatoes (kg)', 0.12]],
  124: [['Chicken Breast', 0.18], ['Beef Bacon (kg)', 0.03], ['Cheese (kg)', 0.04], ['Flour (kg)', 0.04], ['Eggs (dozen)', 0.08], ['Toast Bread (loaf)', 0.06]],
  125: [['Chicken Breast', 0.18], ['Potatoes (kg)', 0.15], ['Cheese (kg)', 0.04], ['Cooking Cream (L)', 0.04], ['Mixed Spices (kg)', 0.004]],
  126: [['Chicken Breast', 0.2], ['Bell Peppers (kg)', 0.08], ['Onions (kg)', 0.07], ['Tortilla (piece)', 2], ['Mixed Spices (kg)', 0.005]],
  127: [['Chicken Breast', 0.22], ['Yogurt (L)', 0.03], ['Garlic (kg)', 0.005], ['Lemons (kg)', 0.03], ['Olive Oil (L)', 0.01]],
  128: [['Tilapia Fillet', 0.2], ['Shrimp (kg)', 0.08], ['Crab Sticks (kg)', 0.05], ['Butter (kg)', 0.02], ['Lemons (kg)', 0.04], ['Mixed Spices (kg)', 0.004]],
  129: [['Tilapia Fillet', 0.15], ['Shrimp (kg)', 0.1], ['Crab Sticks (kg)', 0.05], ['Cooking Cream (L)', 0.05], ['Cheese (kg)', 0.04], ['Tomatoes (kg)', 0.05]],

  // ── Pizza ──
  130: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.08], ['Mozzarella (kg)', 0.12], ['Olive Oil (L)', 0.008]],
  131: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.07], ['Mozzarella (kg)', 0.1], ['Bell Peppers (kg)', 0.04], ['Onions (kg)', 0.03], ['Mushrooms (kg)', 0.03], ['Corn (kg)', 0.02]],
  132: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.07], ['Mozzarella (kg)', 0.1], ['Beef Bacon (kg)', 0.03], ['Pepperoni (kg)', 0.03], ['Bell Peppers (kg)', 0.03], ['Onions (kg)', 0.03], ['Mushrooms (kg)', 0.03]],
  133: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.05], ['Mozzarella (kg)', 0.08], ['Cheese (kg)', 0.06], ['Parmesan (kg)', 0.04], ['Cream Cheese (kg)', 0.04]],
  134: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.06], ['Mozzarella (kg)', 0.09], ['Shrimp (kg)', 0.08], ['Tilapia Fillet', 0.05], ['Ranch Sauce (L)', 0.04]],
  135: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.06], ['Mozzarella (kg)', 0.1], ['Chicken Breast', 0.1], ['BBQ Sauce (L)', 0.04], ['Onions (kg)', 0.03]],
  136: [['Flour (kg)', 0.18], ['Tomatoes (kg)', 0.06], ['Mozzarella (kg)', 0.1], ['Chicken Breast', 0.1], ['Ranch Sauce (L)', 0.04]],
  137: [['Flour (kg)', 0.15], ['Tomatoes (kg)', 0.07], ['Mozzarella (kg)', 0.11], ['Pepperoni (kg)', 0.06]],

  // ── Fresh Juices ──
  148: [['Mango (kg)', 0.3], ['Sugar (kg)', 0.02]],
  149: [['Strawberry (kg)', 0.25], ['Sugar (kg)', 0.02]],
  150: [['Guava (kg)', 0.25], ['Sugar (kg)', 0.02]],
  151: [['Oranges (kg)', 0.4]],
  152: [['Kiwi (kg)', 0.2], ['Sugar (kg)', 0.015]],
  153: [['Kiwi (kg)', 0.12], ['Mango (kg)', 0.18], ['Sugar (kg)', 0.015]],
  154: [['Lemons (kg)', 0.2], ['Sugar (kg)', 0.04]],
  155: [['Lemons (kg)', 0.18], ['Fresh Mint (bunch)', 0.06], ['Sugar (kg)', 0.04]],
  156: [['Banana (kg)', 0.2], ['Milk (L)', 0.15], ['Sugar (kg)', 0.02]],
  157: [['Watermelon (kg)', 0.5]],

  // ── Milkshake ──
  158: [['Milk (L)', 0.2], ['Ice Cream (L)', 0.12], ['Sugar (kg)', 0.02]],
  159: [['Milk (L)', 0.2], ['Ice Cream (L)', 0.12], ['Chocolate (kg)', 0.03], ['Cocoa Powder (kg)', 0.01]],
  160: [['Milk (L)', 0.15], ['Ice Cream (L)', 0.1], ['Mango (kg)', 0.15]],
  161: [['Milk (L)', 0.15], ['Ice Cream (L)', 0.1], ['Strawberry (kg)', 0.12]],
  162: [['Milk (L)', 0.2], ['Ice Cream (L)', 0.12], ['Caramel Syrup (L)', 0.04]],
  163: [['Milk (L)', 0.15], ['Ice Cream (L)', 0.1], ['Blueberry (kg)', 0.1]],
  164: [['Milk (L)', 0.2], ['Ice Cream (L)', 0.12], ['Oreo (pack)', 0.25]],
  165: [['Milk (L)', 0.2], ['Ice Cream (L)', 0.12], ['Lotus Spread (kg)', 0.04]],

  // ── Hot Drinks ──
  166: [['Lemons (kg)', 0.1], ['Honey (kg)', 0.03], ['Ginger (kg)', 0.01], ['Tea Leaves (kg)', 0.005]],
  167: [['Apple (kg)', 0.25], ['Mixed Spices (kg)', 0.002], ['Honey (kg)', 0.02]],
  168: [['Lemons (kg)', 0.12], ['Honey (kg)', 0.03]],
  169: [['Coffee Beans (kg)', 0.008]],
  171: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.05]],
  172: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.05], ['Caramel Syrup (L)', 0.015]],
  173: [['Fresh Mint (bunch)', 0.04]],
  174: [['Tea Leaves (kg)', 0.006]],
  175: [['Tea Leaves (kg)', 0.005]],
  176: [['Milk (L)', 0.2], ['Cornstarch (kg)', 0.01], ['Sugar (kg)', 0.02], ['Nuts (kg)', 0.02]],
  177: [['Milk (L)', 0.2], ['Cornstarch (kg)', 0.01], ['Sugar (kg)', 0.02], ['Lotus Spread (kg)', 0.03]],
  178: [['Coffee Beans (kg)', 0.009]],
  180: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.08], ['Cocoa Powder (kg)', 0.005]],
  182: [['Coffee Beans (kg)', 0.008]],
  183: [['Coffee Beans (kg)', 0.01], ['Milk (L)', 0.12]],
  184: [['Coffee Beans (kg)', 0.009], ['Milk (L)', 0.12]],
  185: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.18]],
  186: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.15], ['Chocolate (kg)', 0.02], ['Cocoa Powder (kg)', 0.005]],
  187: [['Milk (L)', 0.2], ['Chocolate (kg)', 0.03], ['Cocoa Powder (kg)', 0.01]],
  188: [['Milk (L)', 0.2], ['Nutella (kg)', 0.03]],
  189: [['Coffee Beans (kg)', 0.005], ['Milk (L)', 0.05]],

  // ── Iced Coffee & Chocolate ──
  190: [['Coffee Beans (kg)', 0.01], ['Milk (L)', 0.1], ['Sugar (kg)', 0.02]],
  191: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.15]],
  192: [['Coffee Beans (kg)', 0.009], ['Milk (L)', 0.12], ['Chocolate (kg)', 0.005]],
  193: [['Coffee Beans (kg)', 0.009], ['Milk (L)', 0.12], ['Sugar (kg)', 0.025], ['Ice Cream (L)', 0.05]],
  195: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.12], ['Chocolate (kg)', 0.02], ['Sugar (kg)', 0.02]],
  196: [['Milk (L)', 0.18], ['Chocolate (kg)', 0.03], ['Sugar (kg)', 0.02]],

  // ── Frappe, Smoothie & Yogurt ──
  197: [['Oreo (pack)', 0.25], ['Milk (L)', 0.15], ['Ice Cream (L)', 0.08]],
  198: [['Coffee Beans (kg)', 0.008], ['Milk (L)', 0.12], ['Chocolate (kg)', 0.02], ['Ice Cream (L)', 0.05]],
  199: [['Kit Kat (pack)', 0.3], ['Milk (L)', 0.15], ['Ice Cream (L)', 0.08]],
  200: [['Chocolate (kg)', 0.03], ['Marshmallow (pack)', 0.1], ['Milk (L)', 0.15]],
  201: [['Maltesers (pack)', 0.25], ['Milk (L)', 0.15], ['Ice Cream (L)', 0.08]],
  202: [['Strawberry (kg)', 0.15], ['Banana (kg)', 0.1], ['Yogurt (L)', 0.1], ['Honey (kg)', 0.02]],
  203: [['Mango (kg)', 0.2], ['Passion Fruit (kg)', 0.06], ['Sugar (kg)', 0.015]],
  220: [['Yogurt (L)', 0.25], ['Honey (kg)', 0.025]],
  221: [['Yogurt (L)', 0.2], ['Mango (kg)', 0.12]],
  222: [['Yogurt (L)', 0.2], ['Strawberry (kg)', 0.1]],
  223: [['Yogurt (L)', 0.2], ['Blueberry (kg)', 0.08]],
  224: [['Yogurt (L)', 0.2], ['Peach (kg)', 0.1]],
  225: [['Yogurt (L)', 0.2], ['Mango (kg)', 0.05], ['Strawberry (kg)', 0.05], ['Banana (kg)', 0.05]],

  // ── Cocktails ──
  204: [['Lemons (kg)', 0.1], ['Fresh Mint (bunch)', 0.05], ['Soda Water (L)', 0.2], ['Sugar (kg)', 0.03]],
  205: [['Apple (kg)', 0.15], ['Fresh Mint (bunch)', 0.04], ['Soda Water (L)', 0.2], ['Sugar (kg)', 0.03]],
  206: [['Oranges (kg)', 0.2], ['Grenadine Syrup (L)', 0.03], ['Sugar (kg)', 0.02]],
  207: [['Mango (kg)', 0.1], ['Strawberry (kg)', 0.08], ['Banana (kg)', 0.08], ['Milk (L)', 0.08]],
  208: [['Blue Curacao (L)', 0.03], ['Soda Water (L)', 0.15], ['Lemons (kg)', 0.05], ['Sugar (kg)', 0.025]],
  209: [['Mango (kg)', 0.1], ['Passion Fruit (kg)', 0.05], ['Peach (kg)', 0.05], ['Grenadine Syrup (L)', 0.02]],
  210: [['Blue Curacao (L)', 0.03], ['Lemons (kg)', 0.06], ['Soda Water (L)', 0.12], ['Sugar (kg)', 0.02]],
}

/** Local dish id → Neon dish id (p9/p10 re-id policy — see p14 worklog). */
export const DISH_ID_REMAP: Record<number, number> = {
  50: 226,
  51: 227,
  52: 228,
  53: 229,
}
