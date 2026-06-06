import { config } from "dotenv";
config({ path: ".env.local" });
import { db } from "./index";
import { categories } from "./schema";

const STARTER_CATEGORIES = [
  { name: "Income", color: "#22c55e", children: ["Salary", "Freelance", "Investment", "Other Income"] },
  {
    name: "Food & Drink",
    color: "#f97316",
    children: ["Groceries", "Restaurants", "Takeaway / Delivery"],
  },
  {
    name: "Transport",
    color: "#3b82f6",
    children: ["Fuel", "Public Transit", "Ride Share", "Parking", "Car Maintenance"],
  },
  {
    name: "Housing",
    color: "#8b5cf6",
    children: ["Rent", "Mortgage", "Utilities", "Internet", "Home Maintenance"],
  },
  {
    name: "Health",
    color: "#ec4899",
    children: ["Medical", "Pharmacy", "Gym", "Mental Health"],
  },
  {
    name: "Shopping",
    color: "#eab308",
    children: ["Clothing", "Electronics", "Household", "Online"],
  },
  {
    name: "Entertainment",
    color: "#14b8a6",
    children: ["Subscriptions", "Movies", "Games", "Events"],
  },
  {
    name: "Travel",
    color: "#06b6d4",
    children: ["Flights", "Hotels", "Activities"],
  },
  { name: "Education", color: "#6366f1", children: ["Courses", "Books", "Software"] },
  { name: "Finance", color: "#64748b", children: ["Bank Fees", "Interest", "Insurance", "Tax"] },
  { name: "Giving", color: "#f43f5e", children: ["Treats & Meals", "Gifts", "Donations", "Tithe / Offering"] },
  { name: "Transfer", color: "#94a3b8", children: [], isTransfer: true },
  { name: "Uncategorized", color: "#d1d5db", children: [] },
];

async function seed() {
  console.log("Seeding categories...");
  for (const cat of STARTER_CATEGORIES) {
    const [parent] = await db
      .insert(categories)
      .values({
        name: cat.name,
        color: cat.color,
        isTransfer: cat.isTransfer ?? false,
      })
      .onConflictDoNothing()
      .returning();

    if (!parent) continue;

    for (const childName of cat.children ?? []) {
      await db
        .insert(categories)
        .values({ name: childName, parentId: parent.id, color: cat.color })
        .onConflictDoNothing();
    }
  }
  console.log("Done.");
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
