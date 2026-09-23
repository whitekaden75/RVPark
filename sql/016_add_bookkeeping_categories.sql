BEGIN;

CREATE TABLE IF NOT EXISTS bookkeeping_categories (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category_type TEXT NOT NULL DEFAULT 'expense'
    CHECK (category_type IN ('income', 'expense', 'other')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO bookkeeping_categories (name, category_type) VALUES
  ('Revenue', 'income'),
  ('Cost of Goods Sold', 'expense'),
  ('Advertising & Marketing', 'expense'),
  ('Bank & Payment Fees', 'expense'),
  ('Insurance', 'expense'),
  ('Interest Expense', 'expense'),
  ('Legal & Professional Services', 'expense'),
  ('Office & Administrative', 'expense'),
  ('Payroll & Benefits', 'expense'),
  ('Repairs & Maintenance', 'expense'),
  ('Rent & Lease', 'expense'),
  ('Supplies', 'expense'),
  ('Taxes & Licenses', 'expense'),
  ('Travel & Meals', 'expense'),
  ('Utilities', 'expense'),
  ('Vehicle & Fuel', 'expense'),
  ('Other Expense', 'expense')
ON CONFLICT (name) DO NOTHING;

COMMIT;
