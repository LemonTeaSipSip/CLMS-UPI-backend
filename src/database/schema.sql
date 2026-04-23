-- USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    mobile VARCHAR(15) UNIQUE NOT NULL,
    upi_id VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- CREDIT ACCOUNTS TABLE
CREATE TABLE IF NOT EXISTS credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    loan_type VARCHAR(50) NOT NULL,
    total_limit NUMERIC(12,2) NOT NULL,
    available_limit NUMERIC(12,2) NOT NULL,
    status VARCHAR(20) DEFAULT 'ACTIVE',
    upi_pin_hash VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES credit_accounts(id),
    amount NUMERIC(12,2) NOT NULL,
    merchant_name VARCHAR(100),
    mcc VARCHAR(10),
    purpose_code VARCHAR(50),
    status VARCHAR(20),
    rejection_reason VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
);

-- CONSENT LOG TABLE
CREATE TABLE IF NOT EXISTS consent_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    account_id UUID REFERENCES credit_accounts(id),
    consent_text TEXT,
    consented_at TIMESTAMP DEFAULT NOW()
);

-- MCC RULES TABLE (Risk Engine)
CREATE TABLE IF NOT EXISTS mcc_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_type VARCHAR(50) NOT NULL,
    mcc VARCHAR(10) NOT NULL,
    is_allowed BOOLEAN NOT NULL,
    description VARCHAR(100)
);

-- SEED MCC RULES
INSERT INTO mcc_rules (loan_type, mcc, is_allowed, description) VALUES
('EDUCATION_LOAN', '8220', true,  'Colleges & Universities'),
('EDUCATION_LOAN', '8211', true,  'Schools'),
('EDUCATION_LOAN', '5812', false, 'Restaurants - BLOCKED'),
('EDUCATION_LOAN', '7995', false, 'Gambling - BLOCKED'),
('CONSUMER_LOAN',  '5732', true,  'Electronics Stores'),
('CONSUMER_LOAN',  '5411', true,  'Grocery Stores'),
('CONSUMER_LOAN',  '7995', false, 'Gambling - BLOCKED'),
('CONSUMER_LOAN',  '6011', false, 'Cash Withdrawal - BLOCKED'),
('AGRI_LOAN',      '5261', true,  'Farm Supply Stores'),
('AGRI_LOAN',      '0763', true,  'Agricultural Co-ops'),
('AGRI_LOAN',      '5812', true, 'Restaurants'),
('AGRI_LOAN',      '5732', false, 'Electronics - BLOCKED');
