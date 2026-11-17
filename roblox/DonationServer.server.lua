-- Place this Script in ServerScriptService.
-- Set up the BAGIBAGI_API_KEY Secret in the Roblox Creator Dashboard first.

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")
local Debris = game:GetService("Debris")

local API_URL = "https://YOUR-VERCEL-PROJECT.vercel.app/api/roblox"
local POLL_SECONDS = 8
local MAX_ALERT_MESSAGE = 160

local apiKey
local secretOK, secretResult = pcall(function()
    return HttpService:GetSecret("BAGIBAGI_API_KEY")
end)

if secretOK then
    apiKey = secretResult
else
    warn("[DonationSystem] Missing Roblox Secret BAGIBAGI_API_KEY:", secretResult)
end

local remote = ReplicatedStorage:FindFirstChild("DonationUpdate")
if not remote then
    remote = Instance.new("RemoteEvent")
    remote.Name = "DonationUpdate"
    remote.Parent = ReplicatedStorage
end

local function getOrCreateAnchor(name, position)
    local part = Workspace:FindFirstChild(name)
    if part and part:IsA("BasePart") then
        return part
    end

    part = Instance.new("Part")
    part.Name = name
    part.Size = Vector3.new(1, 1, 1)
    part.Position = position
    part.Anchored = true
    part.CanCollide = false
    part.Transparency = 1
    part.Parent = Workspace
    return part
end

-- Move these transparent anchor parts in Studio to position the display.
local alertAnchor = getOrCreateAnchor("DonationAlertAnchor", Vector3.new(0, 10, 18))
local podiumAnchor = getOrCreateAnchor("DonationPodiumAnchor", Vector3.new(0, 3, -18))

local function formatRupiah(value)
    local number = math.floor(tonumber(value) or 0)
    local digits = tostring(number)
    local reversed = digits:reverse()
    local grouped = reversed:gsub("(%d%d%d)", "%1.")
    grouped = grouped:reverse():gsub("^%.", "")
    return "Rp" .. grouped
end

local function makeBillboard(anchor)
    local old = anchor:FindFirstChild("DonationWorldBillboard")
    if old then old:Destroy() end

    local gui = Instance.new("BillboardGui")
    gui.Name = "DonationWorldBillboard"
    gui.Size = UDim2.fromOffset(460, 150)
    gui.StudsOffset = Vector3.new(0, 4, 0)
    gui.AlwaysOnTop = true
    gui.Enabled = false
    gui.Parent = anchor

    local frame = Instance.new("Frame")
    frame.Size = UDim2.fromScale(1, 1)
    frame.BackgroundColor3 = Color3.fromRGB(24, 18, 45)
    frame.BackgroundTransparency = 0.08
    frame.Parent = gui

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 18)
    corner.Parent = frame

    local stroke = Instance.new("UIStroke")
    stroke.Color = Color3.fromRGB(183, 113, 255)
    stroke.Thickness = 2
    stroke.Parent = frame

    local title = Instance.new("TextLabel")
    title.Name = "Title"
    title.BackgroundTransparency = 1
    title.Size = UDim2.new(1, -20, 0, 38)
    title.Position = UDim2.fromOffset(10, 8)
    title.Font = Enum.Font.GothamBlack
    title.Text = "SAWERAN MASUK!"
    title.TextColor3 = Color3.fromRGB(255, 220, 110)
    title.TextScaled = true
    title.Parent = frame

    local donor = Instance.new("TextLabel")
    donor.Name = "Donor"
    donor.BackgroundTransparency = 1
    donor.Size = UDim2.new(1, -20, 0, 40)
    donor.Position = UDim2.fromOffset(10, 48)
    donor.Font = Enum.Font.GothamBold
    donor.Text = ""
    donor.TextColor3 = Color3.new(1, 1, 1)
    donor.TextScaled = true
    donor.Parent = frame

    local amount = Instance.new("TextLabel")
    amount.Name = "Amount"
    amount.BackgroundTransparency = 1
    amount.Size = UDim2.new(1, -20, 0, 34)
    amount.Position = UDim2.fromOffset(10, 92)
    amount.Font = Enum.Font.GothamBold
    amount.Text = ""
    amount.TextColor3 = Color3.fromRGB(116, 255, 190)
    amount.TextScaled = true
    amount.Parent = frame

    return gui, donor, amount
end

local worldBillboard, worldDonor, worldAmount = makeBillboard(alertAnchor)

local function playParticles()
    local attachment = alertAnchor:FindFirstChild("DonationParticlesAttachment")
    if not attachment then
        attachment = Instance.new("Attachment")
        attachment.Name = "DonationParticlesAttachment"
        attachment.Parent = alertAnchor
    end

    local emitter = Instance.new("ParticleEmitter")
    emitter.Name = "DonationBurst"
    emitter.Texture = "rbxasset://textures/particles/sparkles_main.dds"
    emitter.Rate = 0
    emitter.Lifetime = NumberRange.new(1.2, 2)
    emitter.Speed = NumberRange.new(8, 14)
    emitter.SpreadAngle = Vector2.new(360, 360)
    emitter.LightEmission = 1
    emitter.Rotation = NumberRange.new(0, 360)
    emitter.RotSpeed = NumberRange.new(-100, 100)
    emitter.Size = NumberSequence.new({
        NumberSequenceKeypoint.new(0, 0.35),
        NumberSequenceKeypoint.new(1, 0)
    })
    emitter.Parent = attachment
    emitter:Emit(55)
    Debris:AddItem(emitter, 3)
end

local function showWorldAlert(donation)
    worldDonor.Text = tostring(donation.name or "Donatur")
    worldAmount.Text = formatRupiah(donation.amount)
    worldBillboard.Enabled = true
    playParticles()

    task.delay(6, function()
        if worldBillboard then
            worldBillboard.Enabled = false
        end
    end)
end

-- Create podium bases and avatar statues.
local podiumFolder = Workspace:FindFirstChild("BagiBagiTopDonors")
if podiumFolder then podiumFolder:Destroy() end
podiumFolder = Instance.new("Folder")
podiumFolder.Name = "BagiBagiTopDonors"
podiumFolder.Parent = Workspace

local lastPodiumSignature = ""

local function anchorModel(model)
    for _, item in ipairs(model:GetDescendants()) do
        if item:IsA("BasePart") then
            item.Anchored = true
            item.CanCollide = false
        elseif item:IsA("Script") or item:IsA("LocalScript") then
            item:Destroy()
        end
    end
end

local function createPodium(topDonors)
    local signatureParts = {}
    for index = 1, math.min(3, #topDonors) do
        local donor = topDonors[index]
        table.insert(signatureParts, tostring(donor.robloxUsername) .. ":" .. tostring(donor.total))
    end
    local signature = table.concat(signatureParts, "|")
    if signature == lastPodiumSignature then return end
    lastPodiumSignature = signature

    podiumFolder:ClearAllChildren()

    local offsets = {
        [1] = Vector3.new(0, 0, 0),
        [2] = Vector3.new(-8, 0, 0),
        [3] = Vector3.new(8, 0, 0)
    }
    local heights = { 4, 2.5, 1.5 }

    for index = 1, math.min(3, #topDonors) do
        local donor = topDonors[index]
        local offset = offsets[index]
        local height = heights[index]

        local platform = Instance.new("Part")
        platform.Name = "Rank" .. index .. "Platform"
        platform.Size = Vector3.new(5, height, 5)
        platform.Anchored = true
        platform.Material = Enum.Material.Neon
        platform.Color = index == 1 and Color3.fromRGB(255, 190, 65)
            or (index == 2 and Color3.fromRGB(180, 190, 210) or Color3.fromRGB(190, 120, 80))
        platform.CFrame = podiumAnchor.CFrame * CFrame.new(offset.X, height / 2, offset.Z)
        platform.Parent = podiumFolder

        local tag = Instance.new("BillboardGui")
        tag.Name = "DonorNameTag"
        tag.Size = UDim2.fromOffset(260, 76)
        tag.StudsOffset = Vector3.new(0, height + 2, 0)
        tag.AlwaysOnTop = true
        tag.Parent = platform

        local label = Instance.new("TextLabel")
        label.Size = UDim2.fromScale(1, 1)
        label.BackgroundColor3 = Color3.fromRGB(24, 18, 45)
        label.BackgroundTransparency = 0.12
        label.TextColor3 = Color3.new(1, 1, 1)
        label.Font = Enum.Font.GothamBold
        label.TextScaled = true
        label.Text = "#" .. index .. "  " .. tostring(donor.name) .. "\n" .. formatRupiah(donor.total)
        label.Parent = tag

        local username = tostring(donor.robloxUsername or "")
        if #username >= 3 and #username <= 20 and username:match("^[A-Za-z0-9_]+$") then
            task.spawn(function()
                local ok, userId = pcall(function()
                    return Players:GetUserIdFromNameAsync(username)
                end)
                if not ok then
                    warn("[DonationSystem] Roblox username not found:", username)
                    return
                end

                local modelOK, avatar = pcall(function()
                    return Players:CreateHumanoidModelFromUserIdAsync(userId)
                end)
                if not modelOK or not avatar then
                    warn("[DonationSystem] Could not load avatar for:", username)
                    return
                end

                avatar.Name = "TopDonorAvatar_" .. index
                anchorModel(avatar)
                avatar.Parent = podiumFolder
                avatar:PivotTo(podiumAnchor.CFrame * CFrame.new(offset.X, height + 2.8, offset.Z))
            end)
        end
    end
end

local function sendSnapshot(history, leaderboard)
    remote:FireAllClients("snapshot", {
        history = history or {},
        leaderboard = leaderboard or {}
    })
end

local lastReceivedAt = DateTime.now().UnixTimestampMillis
local seenIds = {}

local function pollBackend()
    if not apiKey then return end

    local requestOK, response = pcall(function()
        return HttpService:RequestAsync({
            Url = API_URL .. "?since=" .. tostring(lastReceivedAt),
            Method = "GET",
            Headers = {
                ["x-api-key"] = apiKey,
                ["Accept"] = "application/json"
            }
        })
    end)

    if not requestOK then
        warn("[DonationSystem] HTTP request failed:", response)
        return
    end

    if not response.Success then
        warn("[DonationSystem] Backend returned:", response.StatusCode, response.Body)
        return
    end

    local decodeOK, data = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if not decodeOK or type(data) ~= "table" then
        warn("[DonationSystem] Invalid backend JSON")
        return
    end

    for _, donation in ipairs(data.donations or {}) do
        local id = tostring(donation.id or "")
        if id ~= "" and not seenIds[id] then
            seenIds[id] = true
            lastReceivedAt = math.max(lastReceivedAt, tonumber(donation.receivedAt) or lastReceivedAt)

            showWorldAlert(donation)
            remote:FireAllClients("donation", donation)
        end
    end

    createPodium(data.leaderboard or {})
    sendSnapshot(data.history or {}, data.leaderboard or {})
end

task.spawn(function()
    while true do
        pollBackend()
        task.wait(POLL_SECONDS)
    end
end)

print("[DonationSystem] BagiBagi bridge started.")
