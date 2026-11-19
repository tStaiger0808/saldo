-- Accent-insensitive booking search ("allgau" finds "Allgäu"); unaccent is a trusted extension, so the database owner may create it.
CREATE EXTENSION IF NOT EXISTS unaccent;
