#!/usr/bin/env python3
"""
The Kitchen — planning engine.

Deterministic, pure-Python computations over the kitchen's data files so the
LLM never pays token-cost for math. Reads menu.json, recipes.json, sales.json.

Functions the backend + manager use:
  recipe_costs()          -> per-recipe cost/serving + suggested price
  shopping_list()         -> aggregated ingredients for a set of dishes
  weekly_profit()         -> revenue minus ingredient cost from the sales log
"""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
MENU = BASE / "menu.json"
RECIPES = BASE / "recipes.json"
SALES = BASE / "sales.json"


def _load(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return default


def load_menu():
    return _load(MENU, {"sections": []})


def load_recipes():
    return _load(RECIPES, {"recipes": []})


def load_sales():
    return _load(SALES, {"sales": []})


def recipe_cost(recipe):
    """Return dict with costs for one recipe. Ingredient qty * unit cost."""
    ing_cost = sum(
        float(i.get("qty", 0)) * float(i.get("unit_cost", 0))
        for i in recipe.get("ingredients", [])
    )
    servings = max(int(recipe.get("servings", 1)), 1)
    cost_per_serving = ing_cost / servings
    price = float(recipe.get("price") or 0)
    margin = (price - cost_per_serving) / price if price else 0
    # Suggested price at a target 60% gross margin on cost.
    suggested = cost_per_serving / 0.40 if cost_per_serving else 0
    return {
        "name": recipe.get("name", ""),
        "servings": servings,
        "ingredient_cost": round(ing_cost, 2),
        "cost_per_serving": round(cost_per_serving, 2),
        "price": price,
        "margin_pct": round(margin * 100, 1),
        "suggested_price": round(suggested),
        "underpriced": bool(price and price < suggested),
    }


def recipe_costs():
    return [recipe_cost(r) for r in load_recipes().get("recipes", [])]


def find_recipe(name):
    name_l = (name or "").strip().lower()
    for r in load_recipes().get("recipes", []):
        if r.get("name", "").strip().lower() == name_l:
            return r
    return None


def shopping_list(section_ids=None):
    """Aggregate ingredients across all dishes in the given sections.

    Matches each menu dish to a recipe by name and sums the ingredients.
    Returns {'items': [{item, unit, qty, est_cost}], 'total_cost': float}
    """
    menu = load_menu()
    dishes = []
    for sec in menu.get("sections", []):
        if section_ids is None or sec.get("id") in section_ids:
            dishes.extend(i.get("name", "") for i in sec.get("items", []))

    agg = {}  # item.lower() -> {item, unit, qty, unit_cost}
    for dname in dishes:
        rec = find_recipe(dname)
        if not rec:
            continue
        for ing in rec.get("ingredients", []):
            key = ing.get("item", "").strip().lower()
            if not key:
                continue
            unit = ing.get("unit", "")
            qty = float(ing.get("qty", 0))
            uc = float(ing.get("unit_cost", 0))
            if key in agg:
                agg[key]["qty"] += qty
                agg[key]["est_cost"] += qty * uc
            else:
                agg[key] = {
                    "item": ing.get("item", "").strip(),
                    "unit": unit,
                    "qty": round(qty, 2),
                    "unit_cost": uc,
                    "est_cost": round(qty * uc, 2),
                }

    items = sorted(agg.values(), key=lambda i: i["item"].lower())
    total = round(sum(i["est_cost"] for i in items), 2)
    return {"items": items, "total_cost": total, "dishes_scanned": len(dishes)}


def weekly_profit():
    """Revenue minus ingredient cost from the sales log (current week)."""
    sales = load_sales().get("sales", [])
    revenue = 0.0
    cost = 0.0
    count = 0
    for s in sales:
        name = s.get("dish", "")
        qty = int(s.get("qty", 1))
        rec = find_recipe(name)
        if rec:
            price = float(rec.get("price") or 0)
            cs = recipe_cost(rec)
            revenue += price * qty
            cost += cs["ingredient_cost"] * qty
        else:
            # Sale without a matching recipe: count revenue, note missing.
            revenue += float(s.get("price", 0)) * qty
        count += qty
    return {
        "revenue": round(revenue, 2),
        "ingredient_cost": round(cost, 2),
        "profit": round(revenue - cost, 2),
        "units_sold": count,
        "sales": sales,
    }