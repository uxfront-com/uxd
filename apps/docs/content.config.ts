import { defineDocsCollections } from "@uxfront/layer-docs/content";
import { DOCS_SECTIONS } from "./app/constants/sections";

// One `landing` collection (root markdown) plus one `docs_<key>` collection per
// section. The layer helper reads the section topology this app owns.
export default defineDocsCollections([...DOCS_SECTIONS]);
