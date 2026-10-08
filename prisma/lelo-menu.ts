/**
 * p9 — LELO HOUSE MENU (the operator's real menu, supplied 2026-09-30).
 * p14 — MENU UPSCALE (owner directive 2026-10-01: "check the full menu and
 *       organize it and upscale it, also fix pan lelo to Lilo Pan Dishes").
 *
 * 23 categories · 176 items · prices in EGP exactly as printed on the house
 * menu ("All prices in EGP · Subject to service charge & VAT" — the platform
 * already applies 14% VAT + 12% service on the subtotal at order time).
 * Category Arabic names come straight from the menu headers. 🌶️ dishes are
 * stored as the platform's dietary tag "spicy" (green badge in POS + KDS).
 *
 * p14 upscale (all additive — no item or price was removed or changed):
 *   1. RENAME  "Pan Lelo" → "Lilo Pan Dishes" (owner's exact wording).
 *   2. ORGANIZE the category flow like a printed house menu:
 *        breakfast family → starters → mains → desserts → drinks.
 *      ("Desserts" moved from slot 3 — a leftover demo slot — to after the
 *      mains; every Lelo category now sits in one consecutive 10..32 run.)
 *   3. ARABIC NAMES for every category and all 176 items (the POS localizes
 *      tiles by nameAr and the receipt prints dual-language — the Arabic
 *      half of the menu was empty until now).
 *   4. UPSCALE COPY: every item now carries a description. The house menu's
 *      verbatim descriptions are preserved; placeholder lines ("Beef.",
 *      "Chicken.", "Seafood.") and undDescribed items (drinks, pizzas,
 *      desserts) got proper menu-writing.
 *
 * ADDITIVE-ONLY import:
 *   - Categories are created if missing (name match, honoring `renameFrom`
 *     so the renamed Lilo Pan Dishes finds the existing Pan Lelo row); the
 *     existing demo "Desserts" category is REUSED (avoids two same-named
 *     POS tabs). Existing rows are REFRESHED (name/nameAr/displayOrder/
 *     prep) so re-runs apply the p14 organization.
 *   - Items are keyed by a stable SKU (LO-<CAT>-<nn>) — re-runs UPDATE
 *     price/description/dietary/nameAr for Lelo-managed items only; demo/
 *     seed items (no LO- SKU, different names) are never touched, never
 *     deleted.
 *   - Idempotent: safe to re-run on any DB. Standalone:
 *       bun prisma/lelo-menu.ts
 *   - Wired into prisma/seed.ts after menu-enrichment, so a future reseed
 *     can never lose the Lelo menu either.
 */
import { PrismaClient } from '@prisma/client'

type LeloItem = {
  name: string
  nameAr: string
  price: number
  desc?: string
  spicy?: boolean
}

type LeloCategory = {
  key: string // SKU prefix
  name: string
  nameAr?: string // from the menu header, when printed
  /** p14 rename support: look the row up by its OLD name first */
  renameFrom?: string
  displayOrder: number // 10+ so the demo categories (1-5) keep their slots
  prep: 'kitchen' | 'bar'
  reuse?: string // reuse an existing same-named category instead of creating
  items: LeloItem[]
}

const SOUP_NOTE = 'Served with toasted bread with butter and garlic.'
const ROLLPIE_NOTE = 'Served with salad and potato cubes.'
const MAINDISH_NOTE = 'Served with two side dishes.'

export const LELO_MENU: LeloCategory[] = [
  // ── breakfast family ────────────────────────────────────────────────
  {
    key: 'BF',
    name: 'Breakfast',
    nameAr: 'الفطور',
    displayOrder: 10,
    prep: 'kitchen',
    items: [
      {
        name: 'Oriental Breakfast',
        nameAr: 'الفطار الشرقي',
        price: 195,
        desc: 'Beans of your choice, falafel with sesame, French fries, Alexandrian eggplant, rocca, tomatoes and onions. Served with bread, and juice or tea.',
      },
    ],
  },
  {
    key: 'OM',
    name: 'Omelet',
    nameAr: 'الأومليت',
    displayOrder: 11,
    prep: 'kitchen',
    items: [
      {
        name: 'Cheesy Omelet',
        nameAr: 'أومليت بالجبنة',
        price: 150,
        desc: '3 eggs with cheddar cheese. Served with bread, potato cubes and salad.',
      },
      {
        name: 'Pastrami Omelet',
        nameAr: 'أومليت باستيرامي',
        price: 180,
        desc: '3 eggs with pastrami. Served with bread, potato cubes and salad.',
      },
      {
        name: 'Mix Beef Omelet',
        nameAr: 'أومليت لحم مشكل',
        price: 195,
        desc: '3 eggs with smoked beef, pepperoni and mozzarella. Served with salad and potato cubes.',
      },
      {
        name: 'Eyes Eggs',
        nameAr: 'بيض عيون',
        price: 150,
        desc: '3 eggs cooked eyes style. Served with bread, potato cubes and salad.',
      },
    ],
  },
  {
    key: 'RP',
    name: 'Roll Pie Breakfast',
    nameAr: 'فطار رول باي',
    displayOrder: 12,
    prep: 'kitchen',
    items: [
      {
        name: 'Mix Beef Roll Pie',
        nameAr: 'رول باي لحم مشكل',
        price: 230,
        desc: `Smoked beef, hotdog, mixed cheese, peppers and mushrooms with scrambled eggs. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Kiri Pastrami Pie',
        nameAr: 'باي كيري باستيرامي',
        price: 250,
        desc: `Kiri and pastrami, pepper and olive slices, scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Sausage Roll Pie',
        nameAr: 'رول باي سجق',
        price: 210,
        desc: `Slices of sausage, peppers, tomatoes and olives with scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Mix Cheese Roll Pie',
        nameAr: 'رول باي جبنة مشكلة',
        price: 230,
        desc: `Scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
    ],
  },
  {
    key: 'CSW',
    name: 'Cold Sandwiches',
    nameAr: 'الساندوتشات الباردة',
    displayOrder: 13,
    prep: 'kitchen',
    items: [
      {
        name: 'Chicken Submarine',
        nameAr: 'ساندوتش دجاج صب مارين',
        price: 195,
        desc: 'Sliced chicken with tomatoes, smoked turkey and onion. Served with salad and potato cubes.',
      },
      {
        name: 'Cold Cut Toast',
        nameAr: 'توست كولد كت',
        price: 210,
        desc: 'Sliced smoked beef and smoked turkey with lettuce, tomato, cheese and arugula. Served with salad and potato cubes.',
      },
      {
        name: 'Club Sandwich',
        nameAr: 'كلوب ساندوتش',
        price: 210,
        desc: 'Chicken with mayonnaise, eggs, cheese, smoked beef slices, lettuce and tomatoes. Served with salad and potato cubes.',
      },
    ],
  },
  // ── starters ────────────────────────────────────────────────────────
  {
    key: 'AP',
    name: 'Appetizers',
    nameAr: 'المقبلات',
    displayOrder: 14,
    prep: 'kitchen',
    items: [
      {
        name: 'Chicken Strips',
        nameAr: 'ستربس دجاج',
        price: 150,
        desc: 'Cajun marinated chicken fingers, fried crispy. Served with cocktail dressing.',
      },
      {
        name: 'Half-Moon',
        nameAr: 'هاف مون',
        price: 165,
        desc: 'Fried toast bread stuffed with chicken pieces, pepper, Cajun and cream cheese. Served with cheesy sauce.',
      },
      {
        name: 'Mozzarella Sticks',
        nameAr: 'أصابع الموزاريلا',
        price: 155,
        desc: 'Fried mozzarella sticks. Served with cocktail dressing.',
      },
      {
        name: 'Combo Lelo',
        nameAr: 'كومبو ليلو',
        price: 210,
        desc: '5 pieces of fried mushrooms, crispy chicken, onion rings and mozzarella sticks, served with different sauces.',
      },
    ],
  },
  {
    key: 'SP',
    name: 'Soups',
    nameAr: 'الشوربة',
    displayOrder: 15,
    prep: 'kitchen',
    items: [
      {
        name: 'Mushroom with Bacon Soup',
        nameAr: 'شوربة مشروم بالبيكون',
        price: 70,
        desc: `Mixed mushroom soup with cooked beef bacon pieces and fresh cream. ${SOUP_NOTE}`,
      },
      {
        name: 'Vegetable Soup',
        nameAr: 'شوربة خضار',
        price: 65,
        desc: `Fresh vegetable pieces. ${SOUP_NOTE}`,
      },
      {
        name: 'Orzo Soup',
        nameAr: 'شوربة لسان العصفور',
        price: 65,
        desc: `Your choice of chicken or vegetables. ${SOUP_NOTE}`,
      },
      {
        name: 'Seafood Soup',
        nameAr: 'شوربة سي فود',
        price: 150,
        desc: `Mixed seafood soup with dill and cream. ${SOUP_NOTE}`,
      },
      {
        name: 'Creamy Chicken Soup',
        nameAr: 'شوربة دجاج بالكريمة',
        price: 80,
        desc: `Chicken pieces in fresh creamy soup. ${SOUP_NOTE}`,
      },
    ],
  },
  {
    key: 'SA',
    name: 'Salads',
    nameAr: 'السلطات',
    displayOrder: 16,
    prep: 'kitchen',
    items: [
      {
        name: 'Lelo Salad',
        nameAr: 'سلطة ليلو',
        price: 180,
        desc: 'Fresh rocca, lettuce, Doritos, croutons, red cheese and olive slices, seasoned with Lelo sauce and dill. Choose grilled or crispy chicken.',
      },
      {
        name: 'Chicken Caesar Salad',
        nameAr: 'سلطة سيزر بالدجاج',
        price: 190,
        desc: 'Chicken, lettuce, croutons, Parmesan cheese and Caesar dressing.',
      },
      {
        name: 'Greek Salad',
        nameAr: 'سلطة يوناني',
        price: 150,
        desc: 'Lettuce, olives, tomatoes, cucumber, onions, feta cheese, oregano and Greek sauce.',
      },
      {
        name: 'Chicken Ranch Salad',
        nameAr: 'سلطة رانش بالدجاج',
        price: 180,
        desc: 'Grilled chicken pieces with lettuce, tomatoes, onions, arugula, tortilla bread, cucumbers and grated cheese, seasoned with ranch sauce.',
      },
      {
        name: 'Sweet and Sour Chicken Salad',
        nameAr: 'سلطة حلو وحامض بالدجاج',
        price: 180,
        desc: 'Roasted peppers and carrot lettuce with tomatoes, Doritos, red cheddar and sweet and sour sauce.',
      },
      {
        name: 'Tuna Salad',
        nameAr: 'سلطة تونة',
        price: 230,
        desc: 'Sweet peppers with onions, arugula, lemon juice and mayonnaise.',
      },
      {
        name: 'Oriental Salad',
        nameAr: 'سلطة بلدي',
        price: 65,
        desc: 'All fresh vegetables.',
      },
    ],
  },
  {
    key: 'FR',
    name: 'Fries',
    nameAr: 'البطاطس المحمرة',
    displayOrder: 17,
    prep: 'kitchen',
    items: [
      {
        name: 'Fries Bolognese',
        nameAr: 'بطاطس بولونيز',
        price: 150,
        desc: 'Fries with Bolognese sauce and cheesy sauce.',
      },
      {
        name: 'Fries Jalapeno Pastrami',
        nameAr: 'بطاطس هالبينو باستيرامي',
        price: 180,
        desc: 'Fries with jalapeno, pastrami and cheesy sauce.',
      },
      {
        name: 'Fries Chicken Crispy',
        nameAr: 'بطاطس دجاج كرسبي',
        price: 165,
        desc: 'Fries with crispy chicken and cheesy sauce.',
      },
      {
        name: 'Fries Sausage',
        nameAr: 'بطاطس سجق',
        price: 165,
        desc: 'Fries with Alexandrian sausage and cheesy sauce.',
      },
      {
        name: 'Fries Pepperoni Mozzarella',
        nameAr: 'بطاطس بيبروني موزاريلا',
        price: 210,
        desc: 'Fries with cheese sauce, mozzarella and pepperoni.',
      },
      {
        name: 'Cheese Fries (Large)',
        nameAr: 'بطاطس بالجبنة (كبير)',
        price: 105,
        desc: 'Golden fries topped with warm melted cheese sauce — the large sharing size.',
      },
    ],
  },
  // ── mains ───────────────────────────────────────────────────────────
  {
    key: 'PL',
    name: 'Lilo Pan Dishes', // p14: renamed from "Pan Lelo" per owner directive
    nameAr: 'بان ليلو',
    renameFrom: 'Pan Lelo',
    displayOrder: 18,
    prep: 'kitchen',
    items: [
      {
        name: 'Beef Alexandrian Liver Pan',
        nameAr: 'طاسة كبدة اسكندراني',
        price: 180,
        desc: 'Beef liver with pepper and the special seasoning.',
      },
      {
        name: 'Beef Alexandrian Sausage Pan',
        nameAr: 'طاسة سجق اسكندراني',
        price: 175,
        desc: 'Beef sausage with tomato and hot pepper.',
        spicy: true,
      },
      {
        name: 'Kebab Hala Pan',
        nameAr: 'طاسة كباب حلة',
        price: 220,
        desc: 'Kebab cooked with onions and mixed cheese.',
      },
      {
        name: 'Beef Liver Dips Pan',
        nameAr: 'طاسة كبدة بالديبس',
        price: 190,
        desc: 'Grilled beef liver slices with dips and rocca.',
      },
      {
        name: 'Sausage Melt Pan',
        nameAr: 'طاسة سجق ميلت',
        price: 200,
        desc: 'Grilled sausage pieces with cheese sauce and melted cheese.',
      },
      {
        name: 'Chicken Crispy Melt Pan',
        nameAr: 'طاسة دجاج كرسبي ميلت',
        price: 220,
        desc: 'Crispy chicken pieces with cheese sauce and melted cheese.',
      },
    ],
  },
  {
    key: 'SW',
    name: 'Sandwiches',
    nameAr: 'الساندوتشات',
    displayOrder: 19,
    prep: 'kitchen',
    items: [
      {
        name: 'Cheesy Beef Burger',
        nameAr: 'برجر لحم بالجبنة',
        price: 185,
        desc: 'Juicy beef patty with melted cheddar, lettuce, tomato and pickles in a soft bun.',
      },
      {
        name: 'Burger Doritos B.B.Q',
        nameAr: 'برجر دوريتوس باربكيو',
        price: 195,
        desc: 'Beef patty topped with smoky BBQ sauce, crushed Doritos and melted cheese.',
      },
      {
        name: 'Lelo Beef Sandwich',
        nameAr: 'ساندوتش لحم ليلو',
        price: 210,
        desc: 'The house beef sandwich — spiced minced beef with the signature Lelo sauce.',
      },
      {
        name: 'Alexandrian Liver',
        nameAr: 'كبدة اسكندراني',
        price: 150,
        desc: 'The classic Alexandrian liver sandwich with peppers, tahini and pickles.',
      },
      {
        name: 'Alexandrian Sausage',
        nameAr: 'سجق اسكندراني',
        price: 150,
        desc: 'Spiced Alexandrian sausage with tomato and pickles.',
      },
      {
        name: 'Hawawshi Meat Cheese',
        nameAr: 'حواوشي لحم بالجبنة',
        price: 145,
        desc: 'Crisp hawawshi stuffed with spiced minced meat and melted cheese.',
      },
      {
        name: 'Chicken Crispy Sandwich',
        nameAr: 'ساندوتش دجاج كرسبي',
        price: 180,
        desc: 'Crispy chicken fillet with mayo, lettuce and pickles.',
      },
      {
        name: 'Quesadilla Chicken',
        nameAr: 'كويساديلا دجاج',
        price: 210,
        desc: 'Grilled tortilla folded over chicken and melted cheese, served with salsa and sour cream.',
      },
      {
        name: 'Chicken Lelo',
        nameAr: 'دجاج ليلو',
        price: 195,
        desc: 'The house chicken sandwich — grilled chicken with the signature Lelo sauce.',
      },
      {
        name: 'Chicken Roll Up',
        nameAr: 'دجاج رول أب',
        price: 195,
        desc: 'Rolled tortilla with crispy chicken, cheese and ranch.',
      },
      {
        name: 'Shrimp Ranchy',
        nameAr: 'جمبري رانشي',
        price: 290,
        desc: 'Golden fried shrimp with creamy ranch sauce in a soft bun.',
      },
    ],
  },
  {
    key: 'PA',
    name: 'Pasta',
    nameAr: 'المكرونة',
    displayOrder: 20,
    prep: 'kitchen',
    items: [
      {
        name: 'Arabita',
        nameAr: 'عربياتا',
        price: 110,
        desc: 'Sliced chili with olives, garlic and red sauce.',
        spicy: true,
      },
      {
        name: 'Crispy Doritos Ranch',
        nameAr: 'كرسبي دوريتوس رانش',
        price: 195,
        desc: 'Crispy chicken, jalapeno, tomato pieces, ranch sauce and Doritos pieces.',
      },
      {
        name: 'Mexican Chicken',
        nameAr: 'مكسيكان دجاج',
        price: 210,
        desc: 'Slices of chicken, chili, olives, pepper, hot Mexican sauce and cheese sauce.',
        spicy: true,
      },
      {
        name: 'Crispy Chicken',
        nameAr: 'دجاج كرسبي',
        price: 230,
        desc: 'Crispy chicken pieces with cheese sauce and melted cheese.',
      },
      {
        name: 'Chicken Negresco',
        nameAr: 'نجريسكو دجاج',
        price: 230,
        desc: 'Marinated chicken pieces and mushrooms with Negresco sauce and melted cheese.',
      },
      {
        name: 'Seafood Negresco',
        nameAr: 'نجريسكو سي فود',
        price: 345,
        desc: 'Mixed seafood with crab, Negresco sauce and melted cheese.',
      },
      {
        name: 'Kebab Pasta',
        nameAr: 'مكرونة كباب',
        price: 260,
        desc: 'Cooked kebab with onions and brown sauce, topped with mixed cheese and melted cheese.',
      },
      {
        name: 'Lelo Beef',
        nameAr: 'ليلو لحم',
        price: 250,
        desc: 'Beef mince with mushrooms, peppers and creamy gravy sauce.',
      },
      {
        name: 'Alfredo Chicken',
        nameAr: 'ألفريدو دجاج',
        price: 185,
        desc: 'Alfredo sauce with Parmesan cheese, mushrooms and chicken pieces.',
      },
      {
        name: 'Fruit De Marie',
        nameAr: 'فروت دي ماري',
        price: 340,
        desc: 'Mixed seafood and minced garlic with fresh creamy sauce and dill.',
      },
      {
        name: 'Alexandrian Liver Pasta',
        nameAr: 'مكرونة كبدة اسكندراني',
        price: 185,
        desc: 'Pan-seared Alexandrian beef liver tossed with pasta, peppers and the special seasoning.',
      },
      {
        name: 'Alexandrian Sausage Pasta',
        nameAr: 'مكرونة سجق اسكندراني',
        price: 185,
        desc: 'Spiced Alexandrian sausage tossed with pasta, tomato and hot pepper.',
      },
      {
        name: 'Oven Cheese Sausage',
        nameAr: 'سجق بالجبنة في الفرن',
        price: 230,
        desc: 'Sausage baked with creamy cheese sauce under a golden melted cheese top.',
      },
    ],
  },
  {
    key: 'VE',
    name: 'Vermicelli',
    nameAr: 'الشعرية',
    displayOrder: 21,
    prep: 'kitchen',
    items: [
      {
        name: 'Alexandrian Liver Vermicelli',
        nameAr: 'شعرية كبدة اسكندراني',
        price: 230,
        desc: 'Alexandrian beef liver sautéed with pepper and the special seasoning, served over vermicelli.',
      },
      {
        name: 'Alexandrian Sausage Vermicelli',
        nameAr: 'شعرية سجق اسكندراني',
        price: 230,
        desc: 'Spiced Alexandrian sausage with tomato and hot pepper over vermicelli.',
      },
      {
        name: 'Vermicelli Kebab Halla',
        nameAr: 'شعرية كباب حلة',
        price: 250,
        desc: 'Kebab simmered with onions and mixed cheese, served over vermicelli.',
      },
    ],
  },
  {
    key: 'MD',
    name: 'Main Dishes',
    nameAr: 'الأطباق الرئيسية',
    displayOrder: 22,
    prep: 'kitchen',
    items: [
      {
        name: 'Beef Tenderloin',
        nameAr: 'تندرلويست لحم',
        price: 450,
        desc: `Premium beef tenderloin, charcoal-grilled to your liking. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Beef Stroganoff',
        nameAr: 'استروجانوف لحم',
        price: 425,
        desc: `Tender beef strips simmered in a creamy mushroom sauce. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Beef Fajita',
        nameAr: 'فاهيتا لحم',
        price: 420,
        desc: `Sizzling beef strips with peppers and onions, Mexican style. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Mix Grill',
        nameAr: 'مشكل مشويات',
        price: 450,
        desc: `A charcoal feast — kebab, kofta and tawook. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Piccata Mushroom Sauce',
        nameAr: 'بيكاتا صوص مشروم',
        price: 420,
        desc: `Pan-seared beef in a lemon-butter mushroom sauce. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Veal Scallop',
        nameAr: 'فيليه عجل',
        price: 450,
        desc: `Thin veal scallops, lightly breaded and pan-fried golden. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Grilled Chicken',
        nameAr: 'دجاج مشوي',
        price: 280,
        desc: `Half chicken, marinated overnight and charcoal-grilled. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Cordon Bleu',
        nameAr: 'كوردون بلو',
        price: 299,
        desc: `Chicken breast stuffed with smoked beef and cheese, breaded and fried. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Country Chicken',
        nameAr: 'دجاج كانتري',
        price: 299,
        desc: `Chicken breast in a creamy mushroom sauce. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Chicken Fajita',
        nameAr: 'فاهيتا دجاج',
        price: 320,
        desc: `Sizzling chicken strips with peppers and onions, Mexican style. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Shish Tawook',
        nameAr: 'شيش طاووق',
        price: 285,
        desc: `Marinated chicken skewers, charcoal-grilled. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Fish with Shrimp & Crab',
        nameAr: 'سمك بالجمبري والكابوريا',
        price: 450,
        desc: `Grilled fish topped with shrimp and crab in a creamy sauce. ${MAINDISH_NOTE}`,
      },
      {
        name: 'Mix Seafood Casserole',
        nameAr: 'صينية سي فود مشكل',
        price: 470,
        desc: `Baked casserole of shrimp, calamari and fish with melted cheese. ${MAINDISH_NOTE}`,
      },
    ],
  },
  {
    key: 'PZ',
    name: 'Pizza',
    nameAr: 'البيتزا',
    displayOrder: 23,
    prep: 'kitchen',
    items: [
      {
        name: 'Margarita',
        nameAr: 'بيتزا مارجريتا',
        price: 155,
        desc: 'The classic — tomato sauce and mozzarella finished with olive oil.',
      },
      {
        name: 'Vegetables',
        nameAr: 'بيتزا خضار',
        price: 165,
        desc: 'Garden peppers, olives, onions and mushrooms over mozzarella.',
      },
      {
        name: 'Supreme',
        nameAr: 'بيتزا سوبريم',
        price: 195,
        desc: 'The fully loaded pizza — beef, pepperoni, sausage, peppers, olives, onions and mushrooms.',
      },
      {
        name: 'Quattro Formaggio',
        nameAr: 'بيتزا أربعة أجبان',
        price: 230,
        desc: 'Four-cheese blend of mozzarella, cheddar, roumy and cream cheese.',
      },
      {
        name: 'Seafood Ranch',
        nameAr: 'بيتزا سي فود رانش',
        price: 350,
        desc: 'Shrimp, crab and calamari over creamy ranch sauce with mozzarella.',
      },
      {
        name: 'BBQ Chicken',
        nameAr: 'بيتزا دجاج باربكيو',
        price: 195,
        desc: 'Grilled chicken with smoky BBQ sauce, onions and mozzarella.',
      },
      {
        name: 'Crispy Chicken Ranch',
        nameAr: 'بيتزا دجاج كرسبي رانش',
        price: 195,
        desc: 'Crispy chicken strips with creamy ranch sauce, peppers and mozzarella.',
      },
      {
        name: 'Pepperoni Pizza',
        nameAr: 'بيتزا بيبروني',
        price: 195,
        desc: 'Double pepperoni with mozzarella and our tomato sauce.',
      },
    ],
  },
  // ── desserts (p14: moved from the leftover demo slot 3 to after mains) ──
  {
    key: 'DE',
    name: 'Desserts',
    nameAr: 'الحلويات',
    displayOrder: 24, // p14: reuse demo category, now sequenced after the mains
    prep: 'kitchen',
    reuse: 'Desserts',
    items: [
      {
        name: 'Brownies',
        nameAr: 'براونيز',
        price: 120,
        desc: 'Warm chocolate brownie — dense, fudgy and rich.',
      },
      {
        name: 'Creamy Kunafa',
        nameAr: 'كنافة بالكريمة',
        price: 120,
        desc: 'Golden crisp kunafa layered over velvety cream, finished with aromatic sugar syrup.',
      },
      {
        name: 'Cheese Cake',
        nameAr: 'تشيز كيك',
        price: 120,
        desc: 'Classic New York-style cheesecake on a buttery biscuit base.',
      },
      {
        name: 'Molten Ice Cream',
        nameAr: 'مولتن آيس كريم',
        price: 120,
        desc: 'Chocolate dome with a molten heart, served over vanilla ice cream.',
      },
      {
        name: 'Fettuccine Crepe',
        nameAr: 'كريب فيتوتشيني',
        price: 110,
        desc: 'Crepe sliced into fettuccine ribbons with cream and your choice of topping.',
      },
      {
        name: 'Oreo Madness',
        nameAr: 'أوريو مادنس',
        price: 135,
        desc: 'Crushed Oreo cookies blended with cream and chocolate sauce.',
      },
      {
        name: 'Cheese Madness',
        nameAr: 'تشيز مادنس',
        price: 135,
        desc: 'Triple cheese cream dessert topped with a mixed cheese crumble.',
      },
      {
        name: 'Ice Cream',
        nameAr: 'آيس كريم',
        price: 45,
        desc: 'Premium ice cream — ask for today’s flavors.',
      },
      {
        name: 'Um Ali',
        nameAr: 'أم علي',
        price: 85,
        desc: 'The classic Egyptian bread pudding with cream, milk, nuts and raisins, served warm.',
      },
      {
        name: 'Fruit Salad',
        nameAr: 'سلطة فواكه',
        price: 85,
        desc: 'Seasonal fresh fruits, chilled and freshly cut.',
      },
    ],
  },
  // ── drinks ──────────────────────────────────────────────────────────
  {
    key: 'HD',
    name: 'Hot Drinks',
    nameAr: 'المشروبات الساخنة',
    displayOrder: 25,
    prep: 'bar',
    items: [
      { name: 'Anti-Flu', nameAr: 'مضاد الإنفلونزا', price: 75, desc: 'Hot infusion of lemon, honey, ginger and herbs — the winter warrior.' },
      { name: 'Hot Cider', nameAr: 'سيدر ساخن', price: 85, desc: 'Warm spiced apple cider with cinnamon.' },
      { name: 'Lemon with Honey', nameAr: 'ليمون بالعسل', price: 65, desc: 'Fresh squeezed lemon with natural honey, served hot.' },
      { name: 'Turkish Coffee (Single)', nameAr: 'قهوة تركي (سنجل)', price: 45, desc: 'Traditional Turkish coffee, single serving.' },
      { name: 'Turkish Coffee (Double)', nameAr: 'قهوة تركي (دبل)', price: 55, desc: 'Traditional Turkish coffee, double serving.' },
      { name: 'French Coffee', nameAr: 'قهوة فرنساوي', price: 65, desc: 'Coffee lightened with milk — the Egyptian café classic.' },
      { name: 'Hazelnut Coffee', nameAr: 'قهوة بندق', price: 85, desc: 'Coffee enriched with hazelnut syrup and milk foam.' },
      { name: 'Herbs', nameAr: 'أعشاب', price: 60, desc: 'Your choice of fresh herbs — mint, cinnamon, ginger or anise.' },
      { name: 'Red Tea', nameAr: 'شاي أحمر', price: 40, desc: 'Classic Egyptian tea, served with fresh mint on request.' },
      { name: 'Green Tea', nameAr: 'شاي أخضر', price: 40, desc: 'Light and refreshing green tea.' },
      { name: 'Sahlab with Nuts', nameAr: 'سحلب بالمكسرات', price: 85, desc: 'Creamy sahlab drink topped with mixed nuts and cinnamon.' },
      { name: 'Sahlab Lotus', nameAr: 'سحلب لوتس', price: 95, desc: 'Creamy sahlab swirled with Lotus biscuit spread.' },
      { name: 'Espresso (Single)', nameAr: 'إسبريسو (سنجل)', price: 45, desc: 'Single shot of rich espresso.' },
      { name: 'Espresso (Double)', nameAr: 'إسبريسو (دبل)', price: 55, desc: 'Double shot of rich espresso.' },
      { name: 'Mikato (Single)', nameAr: 'ميكاتو (سنجل)', price: 50, desc: 'Light-roast coffee with steamed milk, single serving.' },
      { name: 'Mikato (Double)', nameAr: 'ميكاتو (دبل)', price: 60, desc: 'Light-roast coffee with steamed milk, double serving.' },
      { name: 'American Coffee', nameAr: 'قهوة أمريكانو', price: 60, desc: 'Espresso diluted with hot water — clean and smooth.' },
      { name: 'Flat White', nameAr: 'فلات وايت', price: 85, desc: 'Double espresso with silky steamed milk.' },
      { name: 'Cappuccino', nameAr: 'كابتشينو', price: 85, desc: 'Espresso with steamed milk and thick foam, dusted with cocoa.' },
      { name: 'Latte Cafe', nameAr: 'لاتيه', price: 80, desc: 'Espresso with plenty of steamed milk — smooth and gentle.' },
      { name: 'Mocha', nameAr: 'موكا', price: 90, desc: 'Espresso with chocolate and steamed milk.' },
      { name: 'Classic Hot Chocolate', nameAr: 'شوكولاتة ساخنة كلاسيك', price: 85, desc: 'Rich chocolate drink topped with cream.' },
      { name: 'Nutella Hot Chocolate', nameAr: 'شوكولاتة ساخنة نوتيلا', price: 95, desc: 'Hot chocolate made with Nutella, topped with cream.' },
      { name: 'Nescafe', nameAr: 'نسكافيه', price: 75, desc: 'Instant coffee, Egyptian style, with milk to taste.' },
    ],
  },
  {
    key: 'IC',
    name: 'Iced Coffee & Chocolate',
    nameAr: 'القهوة والشوكولاتة المثلجة',
    displayOrder: 26,
    prep: 'bar',
    items: [
      { name: 'Iced Coffee', nameAr: 'قهوة مثلجة', price: 80, desc: 'Chilled coffee served over ice with a splash of milk.' },
      { name: 'Iced Latte', nameAr: 'لاتيه مثلج', price: 85, desc: 'Espresso and cold milk over ice.' },
      { name: 'Iced Cappuccino', nameAr: 'كابتشينو مثلج', price: 90, desc: 'Espresso, milk and foam over ice.' },
      { name: 'Light Frappuccino', nameAr: 'فرابيتشينو لايت', price: 90, desc: 'Blended light coffee frappe topped with cream.' },
      { name: 'Strong Frappuccino', nameAr: 'فرابيتشينو سترونج', price: 95, desc: 'Double-shot blended coffee frappe topped with cream.' },
      { name: 'Iced Mocha', nameAr: 'موكا مثلج', price: 95, desc: 'Espresso, chocolate and cold milk over ice.' },
      { name: 'Iced Chocolate', nameAr: 'شوكولاتة مثلجة', price: 95, desc: 'Chilled chocolate drink topped with whipped cream.' },
    ],
  },
  {
    key: 'FS',
    name: 'Frappe & Smoothie',
    nameAr: 'فرابيه وسموثي',
    displayOrder: 27,
    prep: 'bar',
    items: [
      { name: 'Oreo Frappe', nameAr: 'فرابيه أوريو', price: 95, desc: 'Blended Oreo cookies with vanilla ice cream and milk.' },
      { name: 'Mocha Frappe', nameAr: 'فرابيه موكا', price: 90, desc: 'Blended coffee and chocolate with ice cream.' },
      { name: 'Kit Kat Frappe', nameAr: 'فرابيه كيت كات', price: 110, desc: 'Blended Kit Kat with vanilla ice cream and milk.' },
      { name: 'Twist Marshmallow', nameAr: 'تويست مارشميلو', price: 110, desc: 'Chocolate frappe crowned with marshmallow and cream.' },
      { name: 'Maltesers', nameAr: 'مالتيزرز', price: 110, desc: 'Blended Maltesers with chocolate ice cream.' },
      { name: 'Smoothie', nameAr: 'سموذي', price: 95, desc: 'Fresh fruit smoothie — ask for today’s blend.' },
      { name: 'Mango Passion Fruit', nameAr: 'مانجو باشون فروت', price: 95, desc: 'Tropical blend of mango and passion fruit.' },
    ],
  },
  {
    key: 'MS',
    name: 'Milkshake',
    nameAr: 'ميلك شيك',
    displayOrder: 28,
    prep: 'bar',
    items: [
      { name: 'Vanilla Milkshake', nameAr: 'ميلك شيك فانيليا', price: 99, desc: 'Vanilla ice cream blended with fresh milk.' },
      { name: 'Chocolate Milkshake', nameAr: 'ميلك شيك شوكولاتة', price: 99, desc: 'Chocolate ice cream blended with fresh milk and cocoa.' },
      { name: 'Mango Milkshake', nameAr: 'ميلك شيك مانجو', price: 99, desc: 'Mango ice cream blended with fresh milk.' },
      { name: 'Strawberry Milkshake', nameAr: 'ميلك شيك فراولة', price: 99, desc: 'Strawberry ice cream blended with fresh milk.' },
      { name: 'Caramel Milkshake', nameAr: 'ميلك شيك كراميل', price: 99, desc: 'Caramel ice cream blended with fresh milk, topped with caramel drizzle.' },
      { name: 'Blueberry Milkshake', nameAr: 'ميلك شيك بلوبيري', price: 99, desc: 'Blueberry ice cream blended with fresh milk.' },
      { name: 'Oreo Milkshake', nameAr: 'ميلك شيك أوريو', price: 99, desc: 'Oreo cookies blended with vanilla ice cream and milk.' },
      { name: 'Lotus Milkshake', nameAr: 'ميلك شيك لوتس', price: 99, desc: 'Lotus biscuit spread blended with vanilla ice cream and milk.' },
    ],
  },
  {
    key: 'FJ',
    name: 'Fresh Juices',
    nameAr: 'العصائر الطازجة',
    displayOrder: 29,
    prep: 'bar',
    items: [
      { name: 'Mango Juice', nameAr: 'عصير مانجو', price: 85, desc: 'Fresh squeezed seasonal mango — thick and naturally sweet.' },
      { name: 'Strawberry Juice', nameAr: 'عصير فراولة', price: 80, desc: 'Fresh strawberries blended and chilled.' },
      { name: 'Guava Juice', nameAr: 'عصير جوافة', price: 80, desc: 'Fresh guava, blended with a touch of milk on request.' },
      { name: 'Orange Juice', nameAr: 'عصير برتقال', price: 85, desc: 'Freshly squeezed oranges, nothing added.' },
      { name: 'Kiwi Juice', nameAr: 'عصير كيوي', price: 80, desc: 'Fresh kiwi blended and chilled.' },
      { name: 'Kiwi Mango Juice', nameAr: 'عصير كيوي مانجو', price: 95, desc: 'Tropical blend of fresh kiwi and mango.' },
      { name: 'Lemon Juice', nameAr: 'عصير ليمون', price: 65, desc: 'Fresh lemon — sweet or salted to taste.' },
      { name: 'Lemon Mint Juice', nameAr: 'عصير ليمون بالنعناع', price: 70, desc: 'The classic Egyptian lemon crushed with fresh mint.' },
      { name: 'Banana Juice with Milk', nameAr: 'عصير موز باللبن', price: 85, desc: 'Ripe bananas blended with fresh milk.' },
      { name: 'Watermelon Juice', nameAr: 'عصير بطيخ', price: 80, desc: 'Chilled fresh watermelon, lightly blended.' },
    ],
  },
  {
    key: 'CK',
    name: 'Cocktails',
    nameAr: 'الكوكتيلات',
    displayOrder: 30,
    prep: 'bar',
    items: [
      { name: 'Mojito', nameAr: 'موهيتو', price: 95, desc: 'Classic mint and lime cooler with soda.' },
      { name: 'Green Apple Mojito', nameAr: 'موهيتو تفاح أخضر', price: 95, desc: 'Green apple and mint cooler with soda.' },
      { name: 'New Florida', nameAr: 'نيو فلوريدا', price: 95, desc: 'Citrus cooler with orange and grenadine.' },
      { name: 'Lelo Cocktail', nameAr: 'كوكتيل ليلو', price: 99, desc: 'Our signature cocktail — a tropical blend with the Lelo touch.' },
      { name: 'Blue Beach', nameAr: 'بلو بيتش', price: 99, desc: 'Blue curaçao citrus cooler.' },
      { name: 'Tropical', nameAr: 'تروبيكال', price: 99, desc: 'Tropical fruit punch with pineapple and citrus.' },
      { name: 'Blue Lelo', nameAr: 'بلو ليلو', price: 99, desc: 'Our signature blue cocktail — citrus and blue curaçao.' },
    ],
  },
  {
    key: 'SD',
    name: 'Soft Drinks & Water',
    nameAr: 'المشروبات الغازية والمياه',
    displayOrder: 31,
    prep: 'bar',
    items: [
      { name: 'Cola', nameAr: 'كولا', price: 43, desc: 'Chilled cola.' },
      { name: 'Cola Zero', nameAr: 'كولا زيرو', price: 43, desc: 'Chilled zero-sugar cola.' },
      { name: 'Sprite', nameAr: 'سبرايت', price: 43, desc: 'Chilled sprite.' },
      { name: 'Sprite Diet', nameAr: 'سبرايت دايت', price: 43, desc: 'Chilled diet sprite.' },
      { name: 'Red Bull', nameAr: 'ريد بول', price: 95, desc: 'Energy drink, served chilled.' },
      { name: 'Birell', nameAr: 'بيريل', price: 55, desc: 'Non-alcoholic apple malt drink, chilled.' },
      { name: 'Moussy', nameAr: 'موسي', price: 55, desc: 'Non-alcoholic malt drink, chilled.' },
      { name: 'Small Water', nameAr: 'مياه صغيرة', price: 20, desc: 'Small bottled water.' },
      { name: 'Large Water', nameAr: 'مياه كبيرة', price: 30, desc: 'Large bottled water.' },
    ],
  },
  {
    key: 'YG',
    name: 'Yogurt',
    nameAr: 'الزبادي',
    displayOrder: 32,
    prep: 'bar',
    items: [
      { name: 'Yogurt Honey', nameAr: 'زبادي بالعسل', price: 85, desc: 'Fresh yogurt blended with natural honey.' },
      { name: 'Yogurt Mango', nameAr: 'زبادي مانجو', price: 95, desc: 'Fresh yogurt blended with mango.' },
      { name: 'Yogurt Strawberry', nameAr: 'زبادي فراولة', price: 95, desc: 'Fresh yogurt blended with strawberries.' },
      { name: 'Yogurt Blueberry', nameAr: 'زبادي بلوبيري', price: 95, desc: 'Fresh yogurt blended with blueberries.' },
      { name: 'Yogurt Peach', nameAr: 'زبادي خوخ', price: 95, desc: 'Fresh yogurt blended with peaches.' },
      { name: 'Yogurt Fruits', nameAr: 'زبادي فواكه', price: 110, desc: 'Fresh yogurt blended with mixed fruits.' },
    ],
  },
]

/** Total items across the menu (sanity guard for the importer). */
export const LELO_ITEM_COUNT = LELO_MENU.reduce((n, c) => n + c.items.length, 0)

/**
 * Idempotent additive import. Returns counts for honest reporting.
 * Never deletes; only creates missing rows and updates LO-* SKU items.
 * p14: also refreshes existing CATEGORY rows (rename/nameAr/displayOrder/
 * prep) and writes item nameAr on both create and update.
 */
export async function importLeloMenu(db: PrismaClient) {
  let categoriesCreated = 0
  let categoriesReused = 0
  let categoriesRenamed = 0
  let itemsCreated = 0
  let itemsUpdated = 0

  for (const cat of LELO_MENU) {
    // Resolve the category: honor renameFrom (p14 Pan Lelo → Lilo Pan
    // Dishes), then reuse-mapping, then plain name match.
    let row = await db.category.findFirst({
      where: { name: cat.renameFrom ?? cat.reuse ?? cat.name },
      orderBy: { id: 'asc' },
    })
    if (!row && cat.renameFrom) {
      // renamed row may already exist under the NEW name (re-run)
      row = await db.category.findFirst({
        where: { name: cat.name },
        orderBy: { id: 'asc' },
      })
    }
    if (!row) {
      row = await db.category.create({
        data: {
          name: cat.name,
          nameAr: cat.nameAr,
          displayOrder: cat.displayOrder,
          prepDestination: cat.prep,
        },
      })
      categoriesCreated++
    } else {
      const renamed = row.name !== cat.name
      // p14: refresh the row so the organization/rename applies on re-runs
      row = await db.category.update({
        where: { id: row.id },
        data: {
          name: cat.name,
          nameAr: cat.nameAr,
          displayOrder: cat.displayOrder,
          prepDestination: cat.prep,
        },
      })
      if (renamed) categoriesRenamed++
      categoriesReused++
    }

    for (const [i, item] of cat.items.entries()) {
      const sku = `LO-${cat.key}-${String(i + 1).padStart(2, '0')}`
      const data = {
        name: item.name,
        nameAr: item.nameAr,
        categoryId: row.id,
        price: item.price,
        isSellable: true,
        active: true,
        dietary: item.spicy ? '["spicy"]' : null,
        description: item.desc ?? null,
      }
      const existing = await db.product.findFirst({ where: { sku } })
      if (existing) {
        // Lelo-managed item: refresh price/description/tags/Arabic name
        // (menu reprint) — BUT never move a dessert away from the reused
        // demo "Desserts" category (same name, same row — no-op anyway).
        await db.product.update({ where: { id: existing.id }, data })
        itemsUpdated++
      } else {
        await db.product.create({ data: { ...data, sku } })
        itemsCreated++
      }
    }
  }

  return { categoriesCreated, categoriesReused, categoriesRenamed, itemsCreated, itemsUpdated }
}

// ── Standalone runner: `bun prisma/lelo-menu.ts` ─────────────────────
const isDirectRun =
  typeof process !== 'undefined' &&
  (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('lelo-menu.ts')

if (isDirectRun) {
  const db = new PrismaClient()
  importLeloMenu(db)
    .then((r) => {
      const total = LELO_ITEM_COUNT
      console.log(
        `✓ Lelo menu: ${r.itemsCreated} items created, ${r.itemsUpdated} refreshed ` +
          `(expected ${total}) · categories ${r.categoriesCreated} created / ${r.categoriesReused} reused / ${r.categoriesRenamed} renamed`,
      )
      if (r.itemsCreated + r.itemsUpdated !== total) {
        console.error(`✗ COUNT MISMATCH: menu defines ${total} items`)
        process.exitCode = 1
      }
    })
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => db.$disconnect())
}
