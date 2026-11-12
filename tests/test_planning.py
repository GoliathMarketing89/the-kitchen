"""Synthetic tests for the deterministic planning calculations.

These tests use temporary JSON files and never load the bakery's records.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import planning


class PlanningTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.data_dir = Path(self.temp_dir.name)
        self.menu_path = self.data_dir / "menu.json"
        self.recipes_path = self.data_dir / "recipes.json"
        self.sales_path = self.data_dir / "sales.json"
        self.patches = (
            patch.object(planning, "MENU", self.menu_path),
            patch.object(planning, "RECIPES", self.recipes_path),
            patch.object(planning, "SALES", self.sales_path),
        )
        for active_patch in self.patches:
            active_patch.start()
            self.addCleanup(active_patch.stop)

    def write_json(self, path, value):
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_recipe_cost_calculates_batch_portion_and_suggested_price(self):
        recipe = {
            "name": "Sample Loaf",
            "servings": 4,
            "price": 30,
            "ingredients": [
                {"item": "flour", "qty": 2, "unit_cost": 3.25},
                {"item": "sugar", "qty": 1.5, "unit_cost": 2},
            ],
        }

        result = planning.recipe_cost(recipe)

        self.assertEqual(result, {
            "name": "Sample Loaf",
            "servings": 4,
            "ingredient_cost": 9.5,
            "cost_per_serving": 2.38,
            "price": 30.0,
            "margin_pct": 68.3,
            "suggested_price": 24,
            "underpriced": False,
        })

    def test_one_serving_recipe_cost_per_serving_equals_batch_cost(self):
        result = planning.recipe_cost({
            "name": "Sample",
            "servings": 1,
            "price": 20,
            "ingredients": [{"item": "flour", "qty": 2, "unit_cost": 3}],
        })

        self.assertEqual(result["servings"], 1)
        self.assertEqual(result["ingredient_cost"], 6)
        self.assertEqual(result["cost_per_serving"], result["ingredient_cost"])

    def test_shopping_list_aggregates_matching_dishes_with_same_unit(self):
        self.write_json(self.menu_path, {"sections": [
            {"id": "bakery", "items": [{"name": "Sample Loaf"}, {"name": "Tea"}]},
            {"id": "drinks", "items": [{"name": "Other Drink"}]},
        ]})
        self.write_json(self.recipes_path, {"recipes": [
            {"name": "Sample Loaf", "ingredients": [
                {"item": "Flour", "unit": "kg", "qty": 2, "unit_cost": 3},
                {"item": "Sugar", "unit": "kg", "qty": 1, "unit_cost": 4},
            ]},
            {"name": "Tea", "ingredients": [
                {"item": "flour", "unit": "kg", "qty": 0.5, "unit_cost": 3},
            ]},
        ]})

        result = planning.shopping_list(section_ids={"bakery"})

        self.assertEqual(result, {
            "items": [
                {"item": "Flour", "unit": "kg", "qty": 2.5, "unit_cost": 3, "est_cost": 7.5},
                {"item": "Sugar", "unit": "kg", "qty": 1, "unit_cost": 4, "est_cost": 4},
            ],
            "total_cost": 11.5,
            "dishes_scanned": 2,
        })

    def test_shopping_list_empty_section_selection_returns_no_items(self):
        self.write_json(self.menu_path, {"sections": [
            {"id": "cakes", "items": [{"name": "Sample Loaf"}]},
        ]})
        self.write_json(self.recipes_path, {"recipes": [
            {"name": "Sample Loaf", "ingredients": [
                {"item": "flour", "unit": "kg", "qty": 1, "unit_cost": 3},
            ]},
        ]})

        self.assertEqual(planning.shopping_list(section_ids=set()), {
            "items": [], "total_cost": 0, "dishes_scanned": 0,
        })


if __name__ == "__main__":
    unittest.main()
