// Luồng 2 & 5: Mở Ca, Thu Chi Nội Bộ & Đóng Ca (Ý)
// Tầng Model: chỉ chứa SQL & Transaction
const { sql, connectDB } = require('../config/db');

// Tiền mặt dự kiến trong két = Đầu ca + Thu bán hàng - Hoàn tiền + Thu nội bộ - Chi nội bộ
const tinhTienMatDuKien = (s) =>
    Number(s.TienMatDauCa || 0) +
    Number(s.TongThuTienMat || 0) -
    Number(s.TongHoanTienMat || 0) +
    Number(s.TongThuNoiBo || 0) -
    Number(s.TongChiNoiBo || 0);

// ================= LẤY TRẠNG THÁI CA =================
const getShiftByBranch = async (maChiNhanh) => {
    const pool = await connectDB();

    const active = await pool.request()
        .input('MaCN', sql.Int, maChiNhanh)
        .query(`
            SELECT TOP 1 pc.*, nv.HoTen AS TenThuNgan, cn.TenChiNhanh
            FROM PhienCaPOS pc
            JOIN NhanVien nv ON pc.ThuNganMoCa = nv.MaNhanVien
            JOIN ChiNhanh cn ON pc.MaChiNhanh = cn.MaChiNhanh
            WHERE pc.TrangThai = 'open' AND pc.MaChiNhanh = @MaCN
            ORDER BY pc.MaPhienCa DESC
        `);

    const history = await pool.request()
        .input('MaCN', sql.Int, maChiNhanh)
        .query(`
            SELECT TOP 6 pc.*, nv.HoTen AS TenThuNgan
            FROM PhienCaPOS pc
            JOIN NhanVien nv ON pc.ThuNganMoCa = nv.MaNhanVien
            WHERE pc.MaChiNhanh = @MaCN
            ORDER BY pc.MaPhienCa DESC
        `);

    const activeShift = active.recordset[0] || null;
    if (activeShift) activeShift.TienMatDuKien = tinhTienMatDuKien(activeShift);

    return { activeShift, historyShifts: history.recordset };
};

const getShiftById = async (MaPhienCa) => {
    const pool = await connectDB();
    const res = await pool.request()
        .input('MaPhienCa', sql.Int, MaPhienCa)
        .query(`SELECT * FROM PhienCaPOS WHERE MaPhienCa = @MaPhienCa`);
    return res.recordset[0] || null;
};

// ================= XÁC THỰC PIN =================
const verifyStaffPin = async (MaPIN) => {
    const pool = await connectDB();
    const nv = await pool.request()
        .input('MaPIN', sql.VarChar, String(MaPIN))
        .query(`SELECT MaNhanVien, HoTen FROM NhanVien WHERE MaPIN = @MaPIN AND TrangThai = 'active'`);
    return nv.recordset[0] || null;
};

// ================= MỞ CA (Transaction) =================
const createOpenShift = async (branchId, maNhanVien, TienMatDauCa, LyDoLechDauCa, maMayPOS = 1) => {
    const pool = await connectDB();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
        // Khóa kiểm tra lần cuối: tránh 2 thu ngân mở ca cùng lúc
        const check = await new sql.Request(tx)
            .input('MaCN', sql.Int, branchId)
            .query(`SELECT COUNT(*) AS Total FROM PhienCaPOS WITH (UPDLOCK, HOLDLOCK)
                    WHERE MaChiNhanh = @MaCN AND TrangThai = 'open'`);
        if (check.recordset[0].Total > 0) {
            throw new Error('Chi nhánh này đang có một phiên ca mở rồi!');
        }

        const ins = await new sql.Request(tx)
            .input('MaMay', sql.Int, maMayPOS)
            .input('MaCN', sql.Int, branchId)
            .input('ThuNgan', sql.Int, maNhanVien)
            .input('TienDauCa', sql.Decimal(14, 2), TienMatDauCa)
            .input('LyDo', sql.NVarChar, LyDoLechDauCa || 'Khớp ca trước')
            .query(`
                INSERT INTO PhienCaPOS (MaMayPOS, MaChiNhanh, ThuNganMoCa, TienMatDauCa, LyDoLechDauCa, TrangThai)
                OUTPUT INSERTED.MaPhienCa
                VALUES (@MaMay, @MaCN, @ThuNgan, @TienDauCa, @LyDo, 'open');
            `);

        await new sql.Request(tx)
            .input('MaCN', sql.Int, branchId)
            .query(`UPDATE ChiNhanh SET TrangThai = 'open' WHERE MaChiNhanh = @MaCN`);

        await tx.commit();
        return ins.recordset[0].MaPhienCa;
    } catch (err) {
        await tx.rollback();
        throw err;
    }
};

// ================= THU / CHI NỘI BỘ (Transaction) =================
const addCashFlow = async (MaPhienCa, LoaiPhieu, SoTien, LyDo, NguoiTao) => {
    const pool = await connectDB();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
        // Khóa dòng ca + kiểm tra ca còn mở
        const ca = await new sql.Request(tx)
            .input('MaPhienCa', sql.Int, MaPhienCa)
            .query(`SELECT TrangThai, ThuNganMoCa FROM PhienCaPOS WITH (UPDLOCK) WHERE MaPhienCa = @MaPhienCa`);
        if (!ca.recordset[0]) throw new Error('Không tìm thấy phiên ca!');
        if (ca.recordset[0].TrangThai !== 'open') throw new Error('Phiên ca đã đóng, không thể ghi nhận thu chi!');

        const nguoiTao = NguoiTao || ca.recordset[0].ThuNganMoCa;

        await new sql.Request(tx)
            .input('MaPhienCa', sql.Int, MaPhienCa)
            .input('Loai', sql.VarChar, LoaiPhieu)
            .input('SoTien', sql.Decimal(14, 2), SoTien)
            .input('LyDo', sql.NVarChar, LyDo)
            .input('NguoiTao', sql.Int, nguoiTao)
            .query(`
                INSERT INTO PhieuThuChiNoiBo (MaPhienCa, LoaiPhieu, SoTien, LyDo, NguoiTao)
                VALUES (@MaPhienCa, @Loai, @SoTien, @LyDo, @NguoiTao);
            `);

        const col = LoaiPhieu === 'THU' ? 'TongThuNoiBo' : 'TongChiNoiBo';
        await new sql.Request(tx)
            .input('MaPhienCa', sql.Int, MaPhienCa)
            .input('SoTien', sql.Decimal(14, 2), SoTien)
            .query(`UPDATE PhienCaPOS SET ${col} = ${col} + @SoTien WHERE MaPhienCa = @MaPhienCa`);

        await tx.commit();
    } catch (err) {
        await tx.rollback();
        throw err;
    }
};

// ================= ĐẾM ĐƠN CHƯA HOÀN TẤT =================
const countPendingOrdersInShift = async (MaPhienCa) => {
    const pool = await connectDB();
    const res = await pool.request()
        .input('MaPhienCa', sql.Int, MaPhienCa)
        .query(`SELECT COUNT(*) AS Total FROM DonHang
                WHERE MaPhienCa = @MaPhienCa
                  AND TrangThaiDonHang IN ('Pending_Payment', 'Confirmed', 'Preparing')`);
    return res.recordset[0].Total;
};

// ================= ĐÓNG CA (Transaction) =================
const closeShiftRecord = async (MaPhienCa, TienMatThucTeCuoiCa, LyDoChenhLechCuoiCa, maNhanVienDong) => {
    const pool = await connectDB();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
        const ca = await new sql.Request(tx)
            .input('MaPhienCa', sql.Int, MaPhienCa)
            .query(`SELECT * FROM PhienCaPOS WITH (UPDLOCK) WHERE MaPhienCa = @MaPhienCa`);
        const shift = ca.recordset[0];
        if (!shift) throw new Error('Không tìm thấy phiên ca!');
        if (shift.TrangThai !== 'open') throw new Error('Phiên ca này đã được đóng trước đó!');

        const tienDuKien = tinhTienMatDuKien(shift);
        const chenhLech = Number(TienMatThucTeCuoiCa) - tienDuKien;

        await new sql.Request(tx)
            .input('MaPhienCa', sql.Int, MaPhienCa)
            .input('TienThucTe', sql.Decimal(14, 2), TienMatThucTeCuoiCa)
            .input('ChenhLech', sql.Decimal(14, 2), chenhLech)
            .input('LyDo', sql.NVarChar, LyDoChenhLechCuoiCa || 'Khớp két')
            .input('NguoiDong', sql.Int, maNhanVienDong || shift.ThuNganMoCa)
            .query(`
                UPDATE PhienCaPOS
                SET ThoiGianDong = GETDATE(),
                    ThuNganDongCa = @NguoiDong,
                    TienMatThucTeCuoiCa = @TienThucTe,
                    TienChenhLech = @ChenhLech,
                    LyDoChenhLechCuoiCa = @LyDo,
                    TrangThai = 'closed'
                WHERE MaPhienCa = @MaPhienCa
            `);

        // Nếu chi nhánh không còn ca mở nào khác thì đóng cửa chi nhánh
        await new sql.Request(tx)
            .input('MaCN', sql.Int, shift.MaChiNhanh)
            .query(`
                IF NOT EXISTS (SELECT 1 FROM PhienCaPOS WHERE MaChiNhanh = @MaCN AND TrangThai = 'open')
                    UPDATE ChiNhanh SET TrangThai = 'closed' WHERE MaChiNhanh = @MaCN
            `);

        await tx.commit();
        return { TienMatDuKien: tienDuKien, TienChenhLech: chenhLech };
    } catch (err) {
        await tx.rollback();
        throw err;
    }
};

module.exports = {
    getShiftByBranch, getShiftById, verifyStaffPin, createOpenShift,
    addCashFlow, countPendingOrdersInShift, closeShiftRecord
};