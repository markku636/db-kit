-- db-kit sptest 樣本預存程序（SQL Server）。以 GO 分批。
USE sptest;
GO
-- 下單：驗客戶 / 商品 / 數量 / 庫存 → INSERT orders → UPDATE products.stock → 回傳新訂單列。
CREATE OR ALTER PROCEDURE dbo.usp_place_order
  @CustomerID INT, @ProductID INT, @Qty INT
AS
BEGIN
  SET NOCOUNT ON;
  IF NOT EXISTS (SELECT 1 FROM dbo.customers WHERE customer_id = @CustomerID AND is_active = 1)
    THROW 50001, 'customer not found or inactive', 1;
  DECLARE @price DECIMAL(12,2), @stock INT;
  SELECT @price = price, @stock = stock FROM dbo.products WHERE product_id = @ProductID;
  IF @price IS NULL THROW 50002, 'product not found', 1;
  IF @Qty <= 0 THROW 50005, 'qty must be positive', 1;
  IF @stock < @Qty THROW 50003, 'insufficient stock', 1;
  INSERT INTO dbo.orders (customer_id, product_id, qty, total)
    VALUES (@CustomerID, @ProductID, @Qty, @price * @Qty);
  DECLARE @id INT = SCOPE_IDENTITY();
  UPDATE dbo.products SET stock = stock - @Qty WHERE product_id = @ProductID;
  SELECT order_id, qty, total, status FROM dbo.orders WHERE order_id = @id;
  RETURN 0;
END
GO
-- 取消：只有 NEW 可取消；庫存回補。
CREATE OR ALTER PROCEDURE dbo.usp_cancel_order @OrderID INT
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @pid INT, @qty INT, @status NVARCHAR(20);
  SELECT @pid = product_id, @qty = qty, @status = status FROM dbo.orders WHERE order_id = @OrderID;
  IF @pid IS NULL THROW 50004, 'order not found', 1;
  IF @status <> 'NEW' THROW 50006, 'order not cancellable', 1;
  UPDATE dbo.orders SET status = 'CANCELLED' WHERE order_id = @OrderID;
  UPDATE dbo.products SET stock = stock + @qty WHERE product_id = @pid;
END
GO
-- 調整額度：OUTPUT 參數回傳新餘額。
CREATE OR ALTER PROCEDURE dbo.usp_adjust_credit
  @CustomerID INT, @Delta DECIMAL(12,2), @NewBalance DECIMAL(12,2) OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.customers SET credit = credit + @Delta WHERE customer_id = @CustomerID;
  IF @@ROWCOUNT = 0 THROW 50001, 'customer not found', 1;
  SELECT @NewBalance = credit FROM dbo.customers WHERE customer_id = @CustomerID;
END
GO
-- 內含交易控制：巢狀 BEGIN TRAN / COMMIT 在外層交易內只動 @@TRANCOUNT（wrapped 模式仍可用）。
CREATE OR ALTER PROCEDURE dbo.usp_commit_inside @Note NVARCHAR(200)
AS
BEGIN
  SET NOCOUNT ON;
  BEGIN TRAN;
  INSERT INTO dbo.audit_log (note) VALUES (@Note);
  COMMIT;
END
GO
-- 兩個結果集。
CREATE OR ALTER PROCEDURE dbo.usp_two_sets @CustomerID INT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT customer_id, name, credit FROM dbo.customers WHERE customer_id = @CustomerID;
  SELECT order_id, qty, total FROM dbo.orders WHERE customer_id = @CustomerID ORDER BY order_id;
END
GO
