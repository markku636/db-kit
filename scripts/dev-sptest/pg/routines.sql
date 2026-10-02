-- db-kit sptest 樣本函式 / 程序（PostgreSQL）。每個定義以 `$$;` 結尾，整合測試以此切句。
-- 回傳形式依遷移規則：有結果集 → FUNCTION RETURNS TABLE；純副作用 → PROCEDURE；OUTPUT → INOUT。
CREATE OR REPLACE FUNCTION sptest.usp_place_order(p_customer_id INT, p_product_id INT, p_qty INT)
RETURNS TABLE(order_id INT, qty INT, total NUMERIC(12,2), status TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_price NUMERIC(12,2);
  v_stock INT;
  v_id INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sptest.customers c WHERE c.customer_id = p_customer_id AND c.is_active) THEN
    RAISE EXCEPTION 'customer not found or inactive';
  END IF;
  SELECT p.price, p.stock INTO v_price, v_stock FROM sptest.products p WHERE p.product_id = p_product_id;
  IF v_price IS NULL THEN RAISE EXCEPTION 'product not found'; END IF;
  IF p_qty <= 0 THEN RAISE EXCEPTION 'qty must be positive'; END IF;
  IF v_stock < p_qty THEN RAISE EXCEPTION 'insufficient stock'; END IF;
  INSERT INTO sptest.orders (customer_id, product_id, qty, total)
    VALUES (p_customer_id, p_product_id, p_qty, v_price * p_qty)
    RETURNING orders.order_id INTO v_id;
  UPDATE sptest.products p SET stock = p.stock - p_qty WHERE p.product_id = p_product_id;
  RETURN QUERY SELECT o.order_id, o.qty, o.total, o.status FROM sptest.orders o WHERE o.order_id = v_id;
END $$;
-- 刻意錯誤的版本：漏掉庫存扣減（差分測試應抓到 products 的 effect 差異）。
CREATE OR REPLACE FUNCTION sptest.usp_place_order_bad(p_customer_id INT, p_product_id INT, p_qty INT)
RETURNS TABLE(order_id INT, qty INT, total NUMERIC(12,2), status TEXT)
LANGUAGE plpgsql AS $$
DECLARE
  v_price NUMERIC(12,2);
  v_stock INT;
  v_id INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sptest.customers c WHERE c.customer_id = p_customer_id AND c.is_active) THEN
    RAISE EXCEPTION 'customer not found or inactive';
  END IF;
  SELECT p.price, p.stock INTO v_price, v_stock FROM sptest.products p WHERE p.product_id = p_product_id;
  IF v_price IS NULL THEN RAISE EXCEPTION 'product not found'; END IF;
  IF p_qty <= 0 THEN RAISE EXCEPTION 'qty must be positive'; END IF;
  IF v_stock < p_qty THEN RAISE EXCEPTION 'insufficient stock'; END IF;
  INSERT INTO sptest.orders (customer_id, product_id, qty, total)
    VALUES (p_customer_id, p_product_id, p_qty, v_price * p_qty)
    RETURNING orders.order_id INTO v_id;
  RETURN QUERY SELECT o.order_id, o.qty, o.total, o.status FROM sptest.orders o WHERE o.order_id = v_id;
END $$;
CREATE OR REPLACE PROCEDURE sptest.usp_cancel_order(p_order_id INT)
LANGUAGE plpgsql AS $$
DECLARE
  v_pid INT;
  v_qty INT;
  v_status TEXT;
BEGIN
  SELECT o.product_id, o.qty, o.status INTO v_pid, v_qty, v_status FROM sptest.orders o WHERE o.order_id = p_order_id;
  IF v_pid IS NULL THEN RAISE EXCEPTION 'order not found'; END IF;
  IF v_status <> 'NEW' THEN RAISE EXCEPTION 'order not cancellable'; END IF;
  UPDATE sptest.orders SET status = 'CANCELLED' WHERE order_id = p_order_id;
  UPDATE sptest.products SET stock = stock + v_qty WHERE product_id = v_pid;
END $$;
CREATE OR REPLACE PROCEDURE sptest.usp_adjust_credit(p_customer_id INT, p_delta NUMERIC, INOUT p_new_balance NUMERIC)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sptest.customers SET credit = credit + p_delta WHERE customer_id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'customer not found'; END IF;
  SELECT c.credit INTO p_new_balance FROM sptest.customers c WHERE c.customer_id = p_customer_id;
END $$;
-- 內含 COMMIT：只能在 isolated 模式下測（外層交易包著時 PG 會拒絕 COMMIT）。
CREATE OR REPLACE PROCEDURE sptest.usp_commit_inside(p_note TEXT)
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sptest.audit_log (note) VALUES (p_note);
  COMMIT;
END $$;
-- 兩個結果集：PG 只能以 refcursor 表達。
CREATE OR REPLACE FUNCTION sptest.usp_two_sets(p_customer_id INT)
RETURNS SETOF refcursor
LANGUAGE plpgsql AS $$
DECLARE
  c1 refcursor := 'c_customer';
  c2 refcursor := 'c_orders';
BEGIN
  OPEN c1 FOR SELECT c.customer_id, c.name, c.credit FROM sptest.customers c WHERE c.customer_id = p_customer_id;
  RETURN NEXT c1;
  OPEN c2 FOR SELECT o.order_id, o.qty, o.total FROM sptest.orders o WHERE o.customer_id = p_customer_id ORDER BY o.order_id;
  RETURN NEXT c2;
END $$;
