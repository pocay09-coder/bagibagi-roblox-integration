-- Place this LocalScript in StarterPlayer > StarterPlayerScripts.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local player = Players.LocalPlayer
local remote = ReplicatedStorage:WaitForChild("DonationUpdate")

local function rupiah(value)
    local digits = tostring(math.floor(tonumber(value) or 0))
    local reversed = digits:reverse()
    local grouped = reversed:gsub("(%d%d%d)", "%1.")
    grouped = grouped:reverse():gsub("^%.", "")
    return "Rp" .. grouped
end

local gui = Instance.new("ScreenGui")
gui.Name = "BagiBagiDonationGui"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.Parent = player:WaitForChild("PlayerGui")

local alert = Instance.new("Frame")
alert.Name = "DonationAlert"
alert.AnchorPoint = Vector2.new(0.5, 0)
alert.Position = UDim2.new(0.5, 0, 0, -170)
alert.Size = UDim2.fromOffset(440, 132)
alert.BackgroundColor3 = Color3.fromRGB(25, 18, 48)
alert.BackgroundTransparency = 0.05
alert.Parent = gui

local alertCorner = Instance.new("UICorner")
alertCorner.CornerRadius = UDim.new(0, 18)
alertCorner.Parent = alert

local alertStroke = Instance.new("UIStroke")
alertStroke.Color = Color3.fromRGB(180, 105, 255)
alertStroke.Thickness = 2
alertStroke.Parent = alert

local title = Instance.new("TextLabel")
title.BackgroundTransparency = 1
title.Position = UDim2.fromOffset(12, 8)
title.Size = UDim2.new(1, -24, 0, 32)
title.Font = Enum.Font.GothamBlack
title.Text = "SAWERAN MASUK!"
title.TextColor3 = Color3.fromRGB(255, 215, 105)
title.TextScaled = true
title.Parent = alert

local donorLabel = Instance.new("TextLabel")
donorLabel.BackgroundTransparency = 1
donorLabel.Position = UDim2.fromOffset(12, 43)
donorLabel.Size = UDim2.new(1, -24, 0, 34)
donorLabel.Font = Enum.Font.GothamBold
donorLabel.TextColor3 = Color3.new(1, 1, 1)
donorLabel.TextScaled = true
donorLabel.Parent = alert

local amountLabel = Instance.new("TextLabel")
amountLabel.BackgroundTransparency = 1
amountLabel.Position = UDim2.fromOffset(12, 81)
amountLabel.Size = UDim2.new(1, -24, 0, 35)
amountLabel.Font = Enum.Font.GothamBlack
amountLabel.TextColor3 = Color3.fromRGB(110, 255, 185)
amountLabel.TextScaled = true
amountLabel.Parent = alert

local function makePanel(name, titleText, position, size)
    local frame = Instance.new("Frame")
    frame.Name = name
    frame.Position = position
    frame.Size = size
    frame.BackgroundColor3 = Color3.fromRGB(20, 17, 38)
    frame.BackgroundTransparency = 0.12
    frame.Parent = gui

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 12)
    corner.Parent = frame

    local heading = Instance.new("TextLabel")
    heading.BackgroundTransparency = 1
    heading.Position = UDim2.fromOffset(10, 7)
    heading.Size = UDim2.new(1, -20, 0, 28)
    heading.Font = Enum.Font.GothamBold
    heading.Text = titleText
    heading.TextColor3 = Color3.fromRGB(255, 215, 105)
    heading.TextSize = 18
    heading.TextXAlignment = Enum.TextXAlignment.Left
    heading.Parent = frame

    local list = Instance.new("ScrollingFrame")
    list.Name = "List"
    list.Position = UDim2.fromOffset(8, 40)
    list.Size = UDim2.new(1, -16, 1, -48)
    list.BackgroundTransparency = 1
    list.BorderSizePixel = 0
    list.ScrollBarThickness = 4
    list.CanvasSize = UDim2.fromOffset(0, 0)
    list.AutomaticCanvasSize = Enum.AutomaticSize.Y
    list.Parent = frame

    local layout = Instance.new("UIListLayout")
    layout.Padding = UDim.new(0, 5)
    layout.SortOrder = Enum.SortOrder.LayoutOrder
    layout.Parent = list

    return list
end

local leaderboardList = makePanel(
    "LeaderboardPanel",
    "TOP DONATUR",
    UDim2.new(1, -280, 0.22, 0),
    UDim2.fromOffset(260, 270)
)

local historyList = makePanel(
    "HistoryPanel",
    "RIWAYAT SAWERAN",
    UDim2.new(0, 18, 0.22, 0),
    UDim2.fromOffset(290, 270)
)

local function clearRows(list)
    for _, child in ipairs(list:GetChildren()) do
        if child:IsA("TextLabel") then
            child:Destroy()
        end
    end
end

local function addRow(list, text, color, order)
    local row = Instance.new("TextLabel")
    row.LayoutOrder = order
    row.Size = UDim2.new(1, -4, 0, 34)
    row.BackgroundColor3 = Color3.fromRGB(43, 34, 68)
    row.BackgroundTransparency = 0.15
    row.TextColor3 = color or Color3.new(1, 1, 1)
    row.Font = Enum.Font.GothamMedium
    row.TextSize = 14
    row.TextXAlignment = Enum.TextXAlignment.Left
    row.Text = "  " .. text
    row.Parent = list

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 7)
    corner.Parent = row
end

local function showAlert(donation)
    donorLabel.Text = tostring(donation.name or "Donatur")
    amountLabel.Text = rupiah(donation.amount)

    alert.Position = UDim2.new(0.5, 0, 0, -170)
    TweenService:Create(
        alert,
        TweenInfo.new(0.45, Enum.EasingStyle.Back, Enum.EasingDirection.Out),
        { Position = UDim2.new(0.5, 0, 0, 28) }
    ):Play()

    task.delay(5, function()
        TweenService:Create(
            alert,
            TweenInfo.new(0.35, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
            { Position = UDim2.new(0.5, 0, 0, -170) }
        ):Play()
    end)
end

local function updateSnapshot(data)
    clearRows(leaderboardList)
    clearRows(historyList)

    for index, donor in ipairs(data.leaderboard or {}) do
        local username = donor.robloxUsername
        local label = string.format("#%d  %s  •  %s", index, tostring(donor.name), rupiah(donor.total))
        if username and username ~= "" then
            label ..= "  @" .. username
        end
        addRow(leaderboardList, label, index == 1 and Color3.fromRGB(255, 215, 105) or nil, index)
    end

    for index, donation in ipairs(data.history or {}) do
        local label = string.format("%s  •  %s", tostring(donation.name), rupiah(donation.amount))
        addRow(historyList, label, nil, index)
    end
end

remote.OnClientEvent:Connect(function(action, payload)
    if action == "donation" then
        showAlert(payload or {})
    elseif action == "snapshot" then
        updateSnapshot(payload or {})
    end
end)
