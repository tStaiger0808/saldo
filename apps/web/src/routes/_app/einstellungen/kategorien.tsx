import { createFileRoute } from "@tanstack/react-router";
import { CatalogSection } from "../../../components/CatalogSection.tsx";
import { managesHousehold } from "../../../lib/roles.ts";
import { requireSection } from "../../../lib/settings.ts";
import { deleteCategoryFn, getCategories, saveCategoryFn } from "../../../server/functions/catalog.ts";

export const Route = createFileRoute("/_app/einstellungen/kategorien")({
  beforeLoad: requireSection("kategorien"),
  loader: () => getCategories(),
  component: CategoriesSection,
});

function CategoriesSection() {
  const categories = Route.useLoaderData();
  const { user } = Route.useRouteContext();
  return (
    <CatalogSection
      catalog="categories"
      items={categories}
      admin={managesHousehold(user)}
      saveFn={saveCategoryFn}
      deleteFn={deleteCategoryFn}
    />
  );
}
