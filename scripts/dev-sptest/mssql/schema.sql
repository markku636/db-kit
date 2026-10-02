-- db-kit sptest 樣本 schema（SQL Server）。以 GO 分批；整合測試 include_str! 後逐批執行。
-- 刻意讓 orders 的 identity 從 101 起算：三個引擎的自動值互不相同，差分測試必須靠遮罩而非碰巧相等。
IF DB_ID('sptest') IS NULL CREATE DATABASE sptest;
GO
USE sptest;
GO
IF OBJECT_ID('dbo.orders') IS NOT NULL DROP TABLE dbo.orders;
IF OBJECT_ID('dbo.products') IS NOT NULL DROP TABLE dbo.products;
IF OBJECT_ID('dbo.customers') IS NOT NULL DROP TABLE dbo.customers;
IF OBJECT_ID('dbo.audit_log') IS NOT NULL DROP TABLE dbo.audit_log;
GO
CREATE TABLE dbo.customers (
  customer_id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(50) NOT NULL,
  credit DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_active BIT NOT NULL DEFAULT 1
);
CREATE TABLE dbo.products (
  product_id INT IDENTITY(1,1) PRIMARY KEY,
  name NVARCHAR(50) NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  stock INT NOT NULL
);
CREATE TABLE dbo.orders (
  order_id INT IDENTITY(1,1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES dbo.customers(customer_id),
  product_id INT NOT NULL REFERENCES dbo.products(product_id),
  qty INT NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status NVARCHAR(20) NOT NULL DEFAULT 'NEW',
  created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);
CREATE TABLE dbo.audit_log (
  audit_id INT IDENTITY(1,1) PRIMARY KEY,
  note NVARCHAR(200) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSDATETIME()
);
GO
DBCC CHECKIDENT ('dbo.orders', RESEED, 100);
GO
