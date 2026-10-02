-- db-kit sptest 樣本 schema（MySQL 8）。單句一行結尾 `;`，整合測試逐句執行。
-- orders 的 AUTO_INCREMENT 從 500 起算：與 MSSQL（101）/ PG（1000）刻意不同。
CREATE DATABASE IF NOT EXISTS sptest;
DROP TABLE IF EXISTS sptest.orders;
DROP TABLE IF EXISTS sptest.products;
DROP TABLE IF EXISTS sptest.customers;
DROP TABLE IF EXISTS sptest.audit_log;
CREATE TABLE sptest.customers (
  customer_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  credit DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);
CREATE TABLE sptest.products (
  product_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  stock INT NOT NULL
);
CREATE TABLE sptest.orders (
  order_id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  product_id INT NOT NULL,
  qty INT NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'NEW',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES sptest.customers(customer_id),
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES sptest.products(product_id)
) AUTO_INCREMENT = 500;
CREATE TABLE sptest.audit_log (
  audit_id INT AUTO_INCREMENT PRIMARY KEY,
  note VARCHAR(200) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
