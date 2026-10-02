-- db-kit sptest 樣本預存程序（MySQL 8）。mysql CLI 用 DELIMITER $$；整合測試去掉 DELIMITER 行後以 $$ 切句。
USE sptest;
DROP PROCEDURE IF EXISTS sptest.usp_place_order;
DROP PROCEDURE IF EXISTS sptest.usp_cancel_order;
DROP PROCEDURE IF EXISTS sptest.usp_adjust_credit;
DROP PROCEDURE IF EXISTS sptest.usp_commit_inside;
DROP PROCEDURE IF EXISTS sptest.usp_two_sets;
DELIMITER $$
CREATE PROCEDURE sptest.usp_place_order(IN p_customer_id INT, IN p_product_id INT, IN p_qty INT)
BEGIN
  DECLARE v_price DECIMAL(12,2);
  DECLARE v_stock INT;
  DECLARE v_id INT;
  IF NOT EXISTS (SELECT 1 FROM sptest.customers WHERE customer_id = p_customer_id AND is_active = 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer not found or inactive', MYSQL_ERRNO = 50001;
  END IF;
  SELECT price, stock INTO v_price, v_stock FROM sptest.products WHERE product_id = p_product_id;
  IF v_price IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'product not found', MYSQL_ERRNO = 50002;
  END IF;
  IF p_qty <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'qty must be positive', MYSQL_ERRNO = 50005;
  END IF;
  IF v_stock < p_qty THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'insufficient stock', MYSQL_ERRNO = 50003;
  END IF;
  INSERT INTO sptest.orders (customer_id, product_id, qty, total)
    VALUES (p_customer_id, p_product_id, p_qty, v_price * p_qty);
  SET v_id = LAST_INSERT_ID();
  UPDATE sptest.products SET stock = stock - p_qty WHERE product_id = p_product_id;
  SELECT order_id, qty, total, status FROM sptest.orders WHERE order_id = v_id;
END$$
CREATE PROCEDURE sptest.usp_cancel_order(IN p_order_id INT)
BEGIN
  DECLARE v_pid INT;
  DECLARE v_qty INT;
  DECLARE v_status VARCHAR(20);
  SELECT product_id, qty, status INTO v_pid, v_qty, v_status FROM sptest.orders WHERE order_id = p_order_id;
  IF v_pid IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'order not found', MYSQL_ERRNO = 50004;
  END IF;
  IF v_status <> 'NEW' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'order not cancellable', MYSQL_ERRNO = 50006;
  END IF;
  UPDATE sptest.orders SET status = 'CANCELLED' WHERE order_id = p_order_id;
  UPDATE sptest.products SET stock = stock + v_qty WHERE product_id = v_pid;
END$$
CREATE PROCEDURE sptest.usp_adjust_credit(IN p_customer_id INT, IN p_delta DECIMAL(12,2), OUT p_new_balance DECIMAL(12,2))
BEGIN
  UPDATE sptest.customers SET credit = credit + p_delta WHERE customer_id = p_customer_id;
  IF ROW_COUNT() = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'customer not found', MYSQL_ERRNO = 50001;
  END IF;
  SELECT credit INTO p_new_balance FROM sptest.customers WHERE customer_id = p_customer_id;
END$$
CREATE PROCEDURE sptest.usp_commit_inside(IN p_note VARCHAR(200))
BEGIN
  START TRANSACTION;
  INSERT INTO sptest.audit_log (note) VALUES (p_note);
  COMMIT;
END$$
CREATE PROCEDURE sptest.usp_two_sets(IN p_customer_id INT)
BEGIN
  SELECT customer_id, name, credit FROM sptest.customers WHERE customer_id = p_customer_id;
  SELECT order_id, qty, total FROM sptest.orders WHERE customer_id = p_customer_id ORDER BY order_id;
END$$
DELIMITER ;
